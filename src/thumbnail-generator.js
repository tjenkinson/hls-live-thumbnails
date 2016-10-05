var request = require("request");
var url = require("url");
var util = require("util");
var crypto = require("crypto");
var path = require("path");
var m3u8 = require("m3u8");
var Ffmpeg = require("fluent-ffmpeg");
var ee = require("event-emitter");
var Logger = require("./logger");
var nullLogger = require("./null-logger");
var config = require("./config");
var utils = require("./utils");

var ffmpegTimeout = config.ffmpegTimeout;

/**
 * Generates thumbnails from a HLS stream and emits them as they are taken.
 * The output names are [outputNamePrefix]-[segment sequence number]-[thumbnail index]
 * @constructor
 * @param {Object} options
 * @param {String} options.playlistUrl The url to the hls playlist.
 * @param {String} options.outputDir The path to the directory to output the generated thumbnails.
 * @param {String} options.tempDir The path to a temporary directory.
 * @param {Number} [options.initialThumbnailCount] The number of thumbnails to generate initially, from the end of the stream. If ommitted defaults to taking thumbnails for the entire stream.
 * @param {Number} [options.interval] The interval between thumbnails. If omitted the interval will be calculated automatically using `targetThumbnailCount`.
 * @param {Number} [options.targetThumbnailCount] The number of thumbnails that should be generated over the duration of the stream. Defaults to 30. This will be recalculated if the stream duration changes.
 * @param {Number} [options.thumbnailWidth] The width of the thumbnails to generate (px). If omitted this will be calculated automatically from the height, or default to 150.
 * @param {Number} [options.thumbnailHeight] The height of the thumbnails to generate (px). If omitted this will be calculated automatically from the width.
 * @param {String} [options.outputNamePrefix] This will be prepended to the thumbnail names. If omitted this will be generated automatically.
 * @param {Object} [options.logger] An object with `debug`, `info`, `warn` and `error` functions, or null, to disable logging.
 */
function ThumbnailGenerator(options) {
	var opts = Object.assign({
		playlistUrl: null,
		outputDir: null,
		tempDir: null,
		initialThumbnailCount: null,
		interval: null,
		targetThumbnailCount: !options.interval ? 30 : null,
		thumbnailWidth: options.width ? options.width : (!options.height ? 150 : null),
		thumbnailHeight: options.height ? options.height : null,
		outputNamePrefix: null,
		logger: Logger.get('ThumbnailGenerator')
	}, options || {});
	if (!opts.playlistUrl) {
		throw new Error("playlistUrl must be provided.");
	}
	if (!opts.outputDir) {
		throw new Error("outputDir must be provided.");
	}
	if (!opts.tempDir) {
		throw new Error("tempDir must be provided.");
	}
	if (opts.targetThumbnailCount && opts.interval) {
		throw new Error("You cannot use targetThumbnailCount and interval options together.");
	}

	this._playlistUrl = opts.playlistUrl;
	this._targetThumbnailCount = opts.targetThumbnailCount;
	this._interval = opts.interval;
	this._initialThumbnailCount = opts.initialThumbnailCount;
	this._thumbnailSize = this._buildFfmpegSize(opts.thumbnailWidth, opts.thumbnailHeight);
	this._outputDir = opts.outputDir;
	this._tempDir = opts.tempDir;
	this._outputNamePrefix = opts.outputNamePrefix;
	this._logger = opts.logger || nullLogger;

	this._resolvedPlaylistUrl = null;
	this._segmentTargetDuration = null;
	// {sn, time} sequence number and time into that segment
	// that the last thumbnail was taken
	this._lastLocation = null;
	this._grabThumbnailsTimer = null;
	this._destroyed = false;
	this._emitter = ee({});
	this._parsedPlaylist = null;
	this._playlistEnded = false;
	this._endedEventEmitted = false;

	this._getResolvedPlaylistUrl().then((resolvedPlaylistUrl) => {
		this._resolvedPlaylistUrl = resolvedPlaylistUrl;
		if (!this._outputNamePrefix) {
			// user hasn't provided a prefix, use hash of playlist
			this._outputNamePrefix = this._hash(resolvedPlaylistUrl);
		}
	}).catch((err) => {
		this._logger.error("Error determining playlist url.", err.stack);
		this._emit("error", err);
		this.destroy();
		throw err;
	}).then(() => {
		this._grabThumbnails();
	});
}

/**
 * Get the event emitter.
 * The first argument to the listener is the event type.
 * Events:
 * - playlistChanged when the playlist changes. The second argument is the playlist.
 * - playlistEnded when the playlist has ended and all thumbnails have been generated.
 * - playlistRemoved when the playlist is no longer accessible.
 * - newThumbnail when there is a new thumbnail. The second argument is the thumbnail.
 * - error if an exception is thrown before the generator has initialized.
 * @return {Object} An event emitter.
 */
ThumbnailGenerator.prototype.getEmitter = function() {
	return this._emitter;
};

/**
 * Get the latest version of the playlist.
 * @return {Object} The playlist.
 */
ThumbnailGenerator.prototype.getPlaylist = function() {
	return this._parsedPlaylist;
};

/**
 * Destroy the generator.
 * It will stop generating thumbnails and emitting events.
 */
ThumbnailGenerator.prototype.destroy = function() {
	if (this._destroyed) {
		return;
	}
	this._logger.debug("Destroyed.");
	if (this._grabThumbnailsTimer !== null) {
		clearTimeout(this._grabThumbnailsTimer);
	}
	this._destroyed = true;
};

ThumbnailGenerator.prototype._buildFfmpegSize = function(w, h) {
	if (!w && !h) {
		throw new Error("At least one of width or height must be provided.");
	}
	return (w || "?")+"x"+(h || "?");
};

ThumbnailGenerator.prototype._grabThumbnails = function() {
	this._logger.debug("Grabbing thumbnails.");
	return this._getPlaylist().then((parsed) => {
		if (this._destroyed) {
			return;
		}
		
		if (!parsed) {
			this._emit("playlistRemoved");
			this.destroy();
			return;
		}

		if (this._playlistEnded) {
			this._logger.debug("Playlist has ended.");
			return;
		}

		if (!this._hasPlaylistChanged(parsed)) {
			this._logger.debug("Playlist hasn't changed.");
			return;
		}

		this._parsedPlaylist = parsed;
		this._emit("playlistChanged", this._parsedPlaylist);

		var properties = parsed.properties;
		var segments = parsed.segments;
		var firstSN = properties.mediaSequence || 0;
		this._segmentTargetDuration = properties.targetDuration;
		this._playlistEnded = !!properties.foundEndlist;
		var lastLocationSN = this._lastLocation ? this._lastLocation.sn : null;
		var duration = this._calculateSegmentStartTime(segments, segments.length);

		if (this._targetThumbnailCount) {
			// automatically adjust the interval so that we have the requested thumbnail count
			this._interval = duration / this._targetThumbnailCount;
		}

		// time into the playlist to take the next thumbnail
		var nextThumbnailTime = null; 
		var lastLocationSegmentIndex = null;
		if (lastLocationSN !== null) {
			lastLocationSegmentIndex = lastLocationSN - firstSN;
			if (lastLocationSegmentIndex < 0 || lastLocationSegmentIndex > segments.length) {
				// the segment screenshot was last from is no longer in playlist
				lastLocationSegmentIndex = null;
			}
		}

		if (lastLocationSegmentIndex !== null) {
			var lastLocationSegment = segments[lastLocationSegmentIndex];
			var nextSegmentStartTime = this._calculateSegmentStartTime(segments, lastLocationSegmentIndex+1);
			nextThumbnailTime = nextSegmentStartTime + this._interval - lastLocationSegment.properties.duration - this._lastLocation.time;
		}
		else if (!this._initialThumbnailCount) {
			// generate thumbnails from the start
			nextThumbnailTime = 0;
		}
		else {
			nextThumbnailTime = Math.max(0, duration - (this._initialThumbnailCount * this._interval));
		}

		var startSegment = this._getSegmentInfoAtTime(segments, nextThumbnailTime);
		if (!startSegment) {
			this._logger.debug("Next thumbnail segment not available yet.");
			return Promise.resolve();
		}

		var time = startSegment.startTime;
		return handleSegment.bind(this)(startSegment.index);

		function handleSegment(i) {
			return Promise.resolve().then(() => {
				var segment = segments[i];
				var sn = firstSN+i;
				var startTime = time;
				var endTime = time + segment.properties.duration;
				time = endTime;

				if (endTime > nextThumbnailTime) {
					// generate thumbnails from this file
					// the start time could be negative if the last thumbnail for the last segment failed
					var timeIntoSegment = Math.max(0, nextThumbnailTime-startTime);
					return this._generateThumbnails(segment, sn, timeIntoSegment).then((thumbnailData) => {
						if (this._destroyed) {
							return;
						}
						thumbnailData.forEach((item) => {
							var thumbnail = {
								sn: sn,
								name: item.name,
								time: item.time
							};
							this._lastLocation = thumbnail;
							nextThumbnailTime = startTime + item.time + this._interval;
							this._logger.debug("New thumbnail.", thumbnail);
							this._emit("newThumbnail", thumbnail);
						});
					}).catch((err) => {
						this._logger.error("Error whilst generating thumbnails.", err.stack);
					});
				}
				else {
					return Promise.resolve();
				}
			}).catch((err) => {
				this._logger.error("Error whilst handling segment.", err.stack);
			}).then(() => {
				if (!this._destroyed && i+1 < segments.length) {
					// handle next segment
					return handleSegment.bind(this)(i+1);
				}
				else {
					return Promise.resolve();
				}
			});
		}
	}).catch((err) => {
		this._logger.error("Error grabbing thumbnails.", err.stack);
	}).then(() => {
		if (this._destroyed) {
			return;
		}

		if (this._playlistEnded && !this._endedEventEmitted) {
			this._endedEventEmitted = true;
			this._emit("playlistEnded");
		}

		// reschedule
		var interval = null;
		if (this._playlistEnded) {
			// We are now just checking if the playlist is still online.
			// No need to refresh that often.
			interval = 30000;
		}
		else if (this._segmentTargetDuration) {
			interval = Math.max(1000, (this._segmentTargetDuration/2)*1000);
		}
		else {
			interval = 2000;
		}
		this._logger.debug("Finished grabbing thumbnails.");
		this._grabThumbnailsTimer = setTimeout(() => {
			this._grabThumbnails();
		}, interval);
	});
};

ThumbnailGenerator.prototype._hasPlaylistChanged = function(newPlaylist) {
	return !(
		this._parsedPlaylist &&
		this._parsedPlaylist.segments.length === newPlaylist.segments.length &&
		(this._parsedPlaylist.properties.mediaSequence || 0) === (newPlaylist.properties.mediaSequence || 0)
	);
};

// generate thumbnails for a particular segment
ThumbnailGenerator.prototype._generateThumbnails = function(segment, segmentSN, timeIntoSegment) {
	var segmentUrl = url.resolve(this._resolvedPlaylistUrl, segment.properties.uri);
	return this._getUrlBuffer(segmentUrl).then((buffer) => {
		return utils.ensureExists(this._tempDir).then(() => {
			var segmentBaseName = this._outputNamePrefix+"-"+segmentSN;
			var extension = this._getExtension(segmentUrl);
			var segmentFileLocation = path.join(this._tempDir, segmentBaseName+"."+extension);
			return utils.writeFile(segmentFileLocation, buffer).then(() => {
				var outputBaseFilePath = path.join(this._tempDir, segmentBaseName);
				return this._generateThumbnailsWithFfmpeg(segmentFileLocation, segment, timeIntoSegment, outputBaseFilePath);
			}).catch((err) => {
				utils.unlink(segmentFileLocation);
				throw err;
			}).then((files) => {
				utils.unlink(segmentFileLocation);

				if (this._destroyed) {
					return Promise.resolve([]);
				}

				// move the files to the output folder with proper names
				var promises = files.map((location, i) => {
					if (!location) {
						// generation failed for some reason
						// might have been just past the end of the file
						return Promise.resolve(null);
					}
					var newFileName = segmentBaseName+"-"+i+".jpg";
					var newLocation = path.join(this._outputDir, newFileName);
					return utils.ensureExists(this._outputDir).then(() => {
						return utils.move(location, newLocation).then(() => {
							return Promise.resolve(newFileName);
						});
					});
				});
				return Promise.all(promises);
			}).then((fileNames) => {
				return fileNames.map((fileName, i) => {
					if (!fileName) {
						return null;
					}
					return {
						name: fileName,
						time: timeIntoSegment + (this._interval*i)
					};
				}).filter((a) => {
					// filter out the nulls
					return !!a;
				});
			});
		});
	});
};

ThumbnailGenerator.prototype._getSegmentInfoAtTime = function(segments, segmentContainingTime) {
	var time = 0;
	var segmentInfo = null;
	segments.some((segment, i) => {
		var startTime = time;
		time += segment.properties.duration;
		if (time > segmentContainingTime) {
			segmentInfo = {
				index: i,
				startTime: startTime
			};
			return true;
		}
	});
	return segmentInfo;
};

// segmentIndex can be length to get the duration
ThumbnailGenerator.prototype._calculateSegmentStartTime = function(segments, segmentIndex) {
	if (segmentIndex > segments.length) {
		throw new Error("Segment not found.");
	}
	var time = 0;
	segments.some((segment, i) => {
		if (i === segmentIndex) {
			return true;
		}
		time += segment.properties.duration;
	});
	return time;
};

ThumbnailGenerator.prototype._getResolvedPlaylistUrl = function() {
	return this._parsePlaylist(this._playlistUrl).then((parsed) => {
		if (parsed.items.StreamItem.length > 0) {
			// get the first media playlist that is provided
			var newUrl = parsed.items.StreamItem[0].properties.uri;
			newUrl = url.resolve(this._playlistUrl, newUrl);
			return Promise.resolve(newUrl);
		}
		return Promise.resolve(this._playlistUrl);
	});
};

ThumbnailGenerator.prototype._generateThumbnailWithFfmpeg = function(segmentFileLocation, timeIntoSegment, outputFilePath) {
	return new Promise((resolve, reject) => {
		var command = new Ffmpeg({
			timeout: ffmpegTimeout
		}).input(segmentFileLocation)
		.seek(this._roundFfmpeg(timeIntoSegment))
		.noAudio()
		.frames(1)
		.size(this._thumbnailSize)
		.output(outputFilePath)
		.on('end', (stdout, stderr) => {
			utils.exists(outputFilePath).then((exists) => {
				// ffmpeg might fail if the time is right near the end as the duration of the file might be slightly off
				resolve(exists);
			}).catch((err) => {
				reject(err);
			});
		})
		.on("error", (err) => {
			reject(err);
		}).run();
	});
};

ThumbnailGenerator.prototype._generateThumbnailsWithFfmpeg = function(segmentFileLocation, segment, timeIntoSegment, outputBaseFilePath) {
	var time = timeIntoSegment;
	var promises = [];
	var i = 0;
	while (time < segment.properties.duration) {
		((outputPath) => {
			promises.push(this._generateThumbnailWithFfmpeg(segmentFileLocation, time, outputPath).then((success) => {
				return Promise.resolve(success ? outputPath : null);
			}));
		})(outputBaseFilePath+"-"+i+".jpg");
		time += this._interval;
		i++;
	}
	return Promise.all(promises);
};

// round to 3 decimal places for ffmpeg
ThumbnailGenerator.prototype._roundFfmpeg = function(num) {
	return (Math.round(num * 1000) / 1000);
};

// Try X times to get and parse playlist. After X failures resolve with null
// to signify that the playlist is no longer available.
ThumbnailGenerator.prototype._getPlaylist = function() {
	var numAttempts = 0;
	return attempt.bind(this)();

	function attempt() {
		numAttempts++;
		return this._parsePlaylist(this._resolvedPlaylistUrl).then((parsed) => {
			return Promise.resolve({
				segments: parsed.items.PlaylistItem,
				properties: parsed.properties
			});
		}).catch((err) => {
			if (this._destroyed) {
				return Promise.resolve(null);
			}

			this._logger.error("Error trying to get playlist.", err.stack);

			if (err instanceof this._BadStatusCodeException && err.extra === 404) {
				// got a 404
				return Promise.resolve(null);
			}

			if (numAttempts < 3) {
				return this._wait(5000).then(() => {
					return attempt.bind(this)();
				});
			}
			else {
				// give up
				return Promise.resolve(null);
			}
		});
	}
};

ThumbnailGenerator.prototype._parsePlaylist = function(playlistUrl) {
	return this._getUrlBuffer(playlistUrl).then((buffer) => {
		return new Promise((resolve, reject) => {
			var parser = m3u8.createStream();
			parser.on('m3u', (parsed) => {
				resolve(parsed);
			});
			parser.on('error', (error) => {
				reject(error);
			});
			parser.write(buffer.toString());
			parser.end();
		});
	});
};

ThumbnailGenerator.prototype._getUrlBuffer = function(url, dest) {
	return new Promise((resolve, reject) => {
		request({
			url: url,
			encoding: null,
			timeout: 15000
		}, (err, res, body) => {
			if (err) {
				reject(err);
				return;
			}

			if (res.statusCode < 200 || res.statusCode >= 300) {
				reject(new this._BadStatusCodeException(res.statusCode));
				return;
			}
			resolve(body);
		});
	});
};

ThumbnailGenerator.prototype._BadStatusCodeException = function(statusCode) {
	Error.captureStackTrace(this, this.constructor);
	this.name = "BadStatusCode";
	this.message = "Bad status code: "+statusCode;
	this.extra = statusCode;
};
util.inherits(ThumbnailGenerator.prototype._BadStatusCodeException, Error);

ThumbnailGenerator.prototype._getExtension = function(name) {
	var i = name.lastIndexOf(".");
	if (i === -1) {
		return "";
	}
	return name.substring(i+1);
};

ThumbnailGenerator.prototype._wait = function(time) {
	return new Promise((resolve) => {
		setTimeout(() => {
			resolve();
		}, time);
	});
};

ThumbnailGenerator.prototype._emit = function() {
	if (this._destroyed) {
		return;
	}
	var args = Array.prototype.slice.call(arguments);
	try {
		this._emitter.emit.apply(this._emitter, args);
	} catch(err) {
		this._logger.error("Error in event handler.", err.stack);
	}
};

ThumbnailGenerator.prototype._hash = function(str) {
	return crypto.createHash("sha1").update(str).digest("hex");
};

module.exports = ThumbnailGenerator;
