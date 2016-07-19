var path = require("path");
var Logger = require("./logger");
var ee = require("event-emitter");
var ThumbnailGenerator = require("./thumbnail-generator");
var utils = require("./utils");
var nullLogger = require("./null-logger");

/**
 * Starts generating the thumbnails using the configuration in `generatorOptions`.
 * Removes thumbnails when they their segments are removed from the playlist after `expireTime` seconds.
 * @constructor
 * @param {String} options.manifestFileName The name for the manifest file.
 * @param {Object} options The time in seconds to keep thumbnails for before deleting them, once their segments have left the playlist. Defaults to 0.
 * @param {Number} [options.expireTime] The time in seconds to keep thumbnails for before deleting them, once their segments have left the playlist. Defaults to 0.
 * @param {Number} [options.logger] An object with `debug`, `info`, `warn` and `error` functions, or null, to disable logging.
 * @param {Object} [generatorOptions] Configuraton for `ThumbnailGenerator`.
 */
function SimpleThumbnailGenerator(options, generatorOptions) {
	options = options || {};
	generatorOptions = generatorOptions || {};

	if (!options.manifestFileName) {
		throw new Error("manifestFileName required.");
	}

	if (typeof(options.logger) === "undefined") {
		this._logger = Logger.get('SimpleThumbnailGenerator');
	}
	else {
		if (options.logger === null) {
			this._logger = nullLogger;
		}
		else {
			this._logger = options.logger;
		}
	}
	this._generatorOptions = generatorOptions;
	this._manifestFileName = options.manifestFileName;
	this._expireTime = options.expireTime || 0;
	this._segmentRemovalTimes = {
		// the sn of the first fragment in the array
		offset: null,
		// the times when the corresponding fragments were removed
		times: []
	};
	// {sn, thumbnails, removalTime}
	// thumbnails is array of {time, name}
	this._segments = [];
	this._playlistRemoved = false;
	this._playlistEnded = false;
	this._generator = new ThumbnailGenerator(Object.assign({}, generatorOptions, {
		// if the user doesn't provide a temp directory get a general one
		tempDir: generatorOptions.tempDir || utils.getTempDir()
	}));
	this._gcTimerId = setInterval(this._gc.bind(this), 30000);
	this._emitter = ee({});
	this._registerGeneratorListeners();
	this._updateManifest();
}

/**
 * Get the event emitter.
 * The first argument to the listener is the event type.
 * Events:
 * - thumbnailsChanged after a thumbnail is added or removed.
 * - newThumbnail when there is a new thumbnail. The second argument is the thumbnail.
 * - thumbnailRemoved when a thumbnail is removed. The second argument is the thumbnail.
 * - playlistEnded when the playlist has ended and all thumbnails have been generated.
 * - finished when the stream has been removed and all thumbnails have expired.
 * - error if an exception is thrown before the generator has initialized.
 * @return {Object} An event emitter.
 */
SimpleThumbnailGenerator.prototype.getEmitter = function() {
	return this._emitter;
};

/**
 * Destroy the generator.
 * It will stop generating thumbnails and firing events.
 * @param {Boolean} [doNotDeleteFiles] If `true` thumbnails and manifest won't be deleted.
 */
SimpleThumbnailGenerator.prototype.destroy = function(doNotDeleteFiles) {
	if (this._destroyed) {
		return;
	}
	this._destroyed = true;
	if (!doNotDeleteFiles) {
		this._segments.forEach((segment) => {
			segment.thumbnails.forEach((thumbnail) => {
				var file = path.join(this._generatorOptions.outputDir, thumbnail.name);
				return utils.verifiedUnlink(file).then(() => {
					this._logger.debug("Thumbnail deleted.", file);
				}).catch((err) => {
					this._logger.error("Error trying to delete thumbnail.", file, err.stack);
				});
			});
		});
		var manifestFile = path.join(this._generatorOptions.outputDir, this._manifestFileName);
		utils.verifiedUnlink(manifestFile).then(() => {
			this._logger.debug("Manifest deleted.");
		}).catch((err) => {
			this._logger.error("Error deleting manifest.", err);
		});
	}
	clearInterval(this._gcTimerId);
	this._generator.destroy();
};

/**
 * @typedef Segment
 * @type Object
 * @property {Number} sn The sequence number of the segment.
 * @property {Number|null} removalTime The time the segment was removed from the playlist.
 * @property {Array.<Thumbnail>} thumbnails The thumbnails for this segment. 
 */

/**
 * @typedef Thumbnail
 * @type Object
 * @property {String} name The name of the file.
 * @property {Number} time The time into the segment that the thumbnail was taken. 
 */

/**
 * Get an array of sequence numbers with their associated thumbnails.
 * @return {Array.<Segment>} Array of segments with their thumbnails.
 */
SimpleThumbnailGenerator.prototype.getThumbnails = function() {
	return this._segments.map((segment) => {
		return {
			sn: segment.sn,
			removalTime: segment.removalTime,
			thumbnails: segment.thumbnails.slice(0)
		};
	});
};

/**
 * Get an array of thumbnails for a particular sequence number.
 * @param  {Number} sn The sequence number.
 * @return {Array.<Thumbnail>|null}  The thumbnails or null if the segment doesn't exist.
 */
SimpleThumbnailGenerator.prototype.getThumbnailsForSn = function(sn) {
	var thumbnails = this._getSnThumbnails(sn);
	return thumbnails && thumbnails.slice(0);
};

/**
 * Determine if the playlist has ended and there will be no more thumbnails.
 * @return {Boolean} true if there will be no more thumbnails.
 */
SimpleThumbnailGenerator.prototype.hasPlaylistEnded = function() {
	return this._playlistEnded;
};

SimpleThumbnailGenerator.prototype._registerGeneratorListeners = function() {
	this._generator.getEmitter().on("error", (err) => {
		this._logger.error("Error from ThumbnailGenerator.", err);
		this._emit("error", err);
		this.destroy();
	});

	this._generator.getEmitter().on("playlistChanged", (playlist) => {
		var properties = playlist.properties;
		var firstSn = properties.mediaSequence || 0;
		if (this._segmentRemovalTimes.offset === null) {
			// this will be the index of the first segment to be removed, when this happens
			this._segmentRemovalTimes.offset = firstSn;
		}

		this._markSegmentsAsRemoved(firstSn-1);
	});

	this._generator.getEmitter().on("playlistEnded", () => {
		this._playlistEnded = true;
		this._updateManifest();
		this._emit("playlistEnded");
	});

	this._generator.getEmitter().on("playlistRemoved", () => {
		this._playlistRemoved = true;
		var playlist = this._generator.getPlaylist();
		var firstSn = playlist.properties.mediaSequence || 0;
		var lastSn = firstSn + playlist.segments.length - 1;
		this._markSegmentsAsRemoved(lastSn);
	});

	this._generator.getEmitter().on("newThumbnail", (thumbnail) => {
		if (thumbnail.sn < this._segmentRemovalTimes.offset) {
			// this segment has expired
			return;
		}
		var now = Date.now();
		var thumbnails = this._getSnThumbnails(thumbnail.sn, true);
		thumbnails.push({
			time: thumbnail.time,
			name: thumbnail.name
		});
		// sort so that time is ascending
		thumbnails.sort((a, b) => {
			return a.time-b.time;
		});

		this._logger.debug("Thumbnails changed.", thumbnail);
		this._updateManifest();
		this._emit("newThumbnail". thumbnail);
		this._emit("thumbnailsChanged");
	});
};

SimpleThumbnailGenerator.prototype._markSegmentsAsRemoved = function(lastRemovedSn) {
	var offset = this._segmentRemovalTimes.offset;
	// add entries for fragments that have just been removed
	var nextRemovedSn = offset + this._segmentRemovalTimes.times.length;

	var numRemoved = Math.max(0, lastRemovedSn + 1 - nextRemovedSn);
	if (!numRemoved) {
		return;
	}
	var now = Date.now();
	for (var i=0; i<numRemoved; i++) {
		this._segmentRemovalTimes.times.push(now);
	}
};

SimpleThumbnailGenerator.prototype._gc = function() {
	var expireTime = Date.now() + (this._expireTime*1000);

	var highestExpiredSegmentSn = null;
	var offset = this._segmentRemovalTimes.offset;
	this._segmentRemovalTimes.times = this._segmentRemovalTimes.times.filter((time, i) => {
		if (time <= expireTime) {
			highestExpiredSegmentSn = offset + i;
			return false;
		}
		return true;
	});

	if (highestExpiredSegmentSn === null) {
		return;
	}
	this._segmentRemovalTimes.offset = highestExpiredSegmentSn+1;

	this._segments = this._segments.filter((segment) => {
		if (segment.sn <= highestExpiredSegmentSn) {
			this._logger.debug("Segment expired.", segment.sn);
			segment.thumbnails.forEach((thumbnail) => {
				var file = path.join(this._generatorOptions.outputDir, thumbnail.name);
				return utils.verifiedUnlink(file).then(() => {
					this._logger.debug("Thumbnail deleted.", file);
					this._updateManifest();
					this._emit("thumbnailRemoved". thumbnail);
					this._emit("thumbnailsChanged");
				}).catch((err) => {
					this._logger.error("Error trying to delete thumbnail.", file, err.stack);
				});
			});
			return false;
		}
		return true;
	});

	if (this._playlistRemoved && this._segments.length === 0) {
		this._emit("finished");
		this.destroy();
	}
};

SimpleThumbnailGenerator.prototype._updateManifest = function() {
	var segments = this.getThumbnails();
	var ended = this._playlistEnded;
	var manifest = JSON.stringify({
		segments: segments,
		ended: ended
	});
	var outputDir = this._generatorOptions.outputDir;
	var manifestFile = path.join(outputDir, this._manifestFileName);
	return utils.ensureExists(outputDir).then(() => {
		return utils.writeFile(manifestFile, manifest).then(() => {
			if (this._destroyed) {
				// delete it
				return utils.verifiedUnlink(manifestFile);
			}
		});
	}).catch((err) => {
		if (!this._destroyed) {
			this._logger.error("Error writing manifest file.", err);
		}
	});
};

SimpleThumbnailGenerator.prototype._emit = function() {
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

SimpleThumbnailGenerator.prototype._getSnThumbnails = function(sn, create) {
	var segment = this._segments.find((segment) => {
		return segment.sn === sn;
	});
	if (segment) {
		return segment.thumbnails;
	}
	if (!create) {
		if (sn > this._segmentRemovalTimes.offset) {
			// this segment hasn't been deleted but there were no thumbnails for it
			return [];
		}
		return null;
	}

	if (sn < this._segmentRemovalTimes.offset) {
		throw new Error("This fragment has left the playlist.");
	}

	// create and return
	var newThumbnails = [];
	var newSegment = {
		sn: sn,
		thumbnails: newThumbnails
	};
	this._segments.push(newSegment);
	return newThumbnails;
};

module.exports = SimpleThumbnailGenerator;
