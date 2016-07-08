#!/usr/bin/env node
var path = require("path");
var commandLineArgs = require('command-line-args');
var ThumbnailGeneratorService = require("./thumbnail-generator-service");

var optionDefinitions = [
	{ name: 'port', alias: 'p', type: Number, defaultOption: true, defaultValue: 8080 },
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
	{ name: 'height', alias: 'h', type: Number },
];

var options = commandLineArgs(optionDefinitions);

if (options.port % 1 !== 0) {
	throw new Error("Port invalid.")
}

var port = options.port;
var outputDir = path.resolve(options.outputDir);
var tempDir = options.tempDir ? path.resolve(options.tempDir) : null;
var secret = options.secret || null;
var expireTime = options.expireTime || 0;
var interval = options.interval || null;
var initialThumbnailCount = options.initialThumbnailCount || null;
var targetThumbnailCount = !interval ? options.targetThumbnailCount || 30 : null;
var height = options.height || null;
var width = options.width || (options.height ? null : 150);

new ThumbnailGeneratorService({
	secret: secret,
	port: port
}, {
	expireTime: expireTime
}, {
	outputDir: outputDir,
	tempDir: tempDir,
	interval: interval,
	targetThumbnailCount: targetThumbnailCount,
	width: width,
	height: height
});