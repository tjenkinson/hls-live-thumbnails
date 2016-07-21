#!/usr/bin/env node
var path = require("path");
var commandLineArgs = require('command-line-args');
var SimpleThumbnailGenerator = require("./simple-thumbnail-generator");
var ThumbnailGeneratorService = require("./thumbnail-generator-service");
var utils = require("./utils");
var Logger = require("./logger");

var optionDefinitions = [
	// If provided download the thumbnails for this stream and then quit
	{ name: 'url', alias: 'u', type: String, defaultOption: true },
	// If url provided use this file name for the manifest file.
	{ name: 'manifestFileName', alias: 'm', type: String},
	
	// If provided start a server running on this port listening for commands
	{ name: 'port', alias: 'p', type: Number, defaultValue: null },
	// Ping request must be made every pingInterval seconds or thumbnail generation will automatically stop. Defaults to disabled.
	{ name: 'pingInterval', type: Number },
	// empty the output directory on startup
	{ name: 'clearOutputDir', type: Boolean, defaultValue: false },
	{ name: 'outputDir', alias: 'o', type: String, defaultValue: "./output" },
	{ name: 'tempDir', alias: 't', type: String },
	{ name: 'secret', alias: 's', type: String },
	// The time in seconds to keep thumbnails for before deleting them, once their segments have left the playlist. Defaults to 0.
	{ name: 'expireTime', alias: 'e', type: Number },
	// The default interval between thumbnails. If omitted the interval will be calculated automatically using `targetThumbnailCount`.
	{ name: 'interval', alias: 'i', type: Number },
	// The default number of thumbnails to generate initially, from the end of the stream. If ommitted defaults to taking thumbnails for the entire stream.
	{ name: 'initialThumbnailCount', type: Number },
	// The default number of thumbnails that should be generated over the duration of the stream. Defaults to 30. This will be recalculated if the stream duration changes.
	{ name: 'targetThumbnailCount', alias: 'c', type: Number },
	// The default width of the thumbnails to generate (px). If omitted this will be calculated automatically from the height, or default to 150.
	{ name: 'width', alias: 'w', type: Number },
	// The default height of the thumbnails to generate (px). If omitted this will be calculated automatically from the width.
	{ name: 'height', alias: 'h', type: Number }
];

var options = commandLineArgs(optionDefinitions);

if (options.url && options.port !== null) {
	throw new Error("Cannot use 'url' and 'port' together.");
}

if (options.url && options.pingInterval) {
	throw new Error("Cannot use 'url' and 'pingInterval' together.");
}

if (options.url && options.secret) {
	throw new Error("Cannot use 'url' and 'secret' together.");
}

if (!options.url && options.manifestFileName) {
	throw new Error("'manifestFileName' can only be used with the 'url' option.");
}

if (port !== null && options.port % 1 !== 0) {
	throw new Error("Port invalid.");
}

var logger = Logger.get("SimpleThumbnailGeneratorCLI");
var url = options.url;
var manifestFileName = url ? options.manifestFileName || "thumbnails.json" : null;
var port = !url ? options.port || 8080 : null;
var pingInterval = options.pingInterval || null;
var clearOutputDir = options.clearOutputDir;
var outputDir = path.resolve(options.outputDir);
var tempDir = options.tempDir ? path.resolve(options.tempDir) : null;
var secret = options.secret || null;
var expireTime = options.expireTime || 0;
var interval = options.interval || null;
var initialThumbnailCount = options.initialThumbnailCount || null;
var targetThumbnailCount = !interval ? options.targetThumbnailCount || 30 : null;
var height = options.height || null;
var width = options.width || (options.height ? null : 150);

var simpleThumbnailGeneratorOptions = {
	expireTime: expireTime,
	manifestFileName: manifestFileName
};
var thumbnailGeneratorOptions = {
	playlistUrl: url,
	outputDir: outputDir,
	tempDir: tempDir,
	interval: interval,
	initialThumbnailCount: initialThumbnailCount,
	targetThumbnailCount: targetThumbnailCount,
	width: width,
	height: height
};

Promise.resolve().then(() => {
	if (clearOutputDir) {
		return utils.exists(outputDir).then((exists) => {
			if (exists) {
				logger.debug("Clearing output directory.");
				return utils.emptyDir(outputDir).then(() => {
					logger.debug("Output directory cleared.");
				});
			}
		});
	}
}).then(() => {
	if (url) {
		// generate thumbnails for this url and then terminate
		var generator = new SimpleThumbnailGenerator(simpleThumbnailGeneratorOptions, thumbnailGeneratorOptions);
		var emitter = generator.getEmitter();
		emitter.on("error", (err) => {
			logger.error("Error", err.stack);
			process.exit(1);
		});

		emitter.on("finished", (err) => {
			logger.debug("Finished");
			process.exit(0);
		});
	}
	else {
		new ThumbnailGeneratorService({
			secret: secret,
			port: port,
			pingInterval: pingInterval
		}, simpleThumbnailGeneratorOptions, thumbnailGeneratorOptions);
	}
}).catch((err) => {
	logger.error("Error", err.stack);
	process.exit(1);
});