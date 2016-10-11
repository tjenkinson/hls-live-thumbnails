var crypto = require("crypto");
var SimpleThumbnailGenerator = require("./simple-thumbnail-generator");
var Logger = require("./logger");
var express = require('express');
var bodyParser = require('body-parser');
var nullLogger = require("./null-logger");
var utils = require("./utils");

/**
 * Start a web service which will allow thumbnail generation to be controlled by web requests.
 * Requests are
 * - POST /v1/start
 *   - start generating thumbnails
 *   - manifest will be at "thumbnails-[id].json"
 *   - fields
 *     - url
 *   - response
 *     - {id: <id used for further communication>}
 * - GET /v1/generators/{id}
 *     - {ended: <true or false>}
 * - DELETE /v1/generators/{id}
 *   - stop generating and remove thumbnails for stream
 * @constructor
 * @param {Object} options
 * @param {Number} [options.port] The port to listen on. Defaults to 8080.
 * @param {String} [options.secret] A secret which is required with requests. Defaults to null which disables this. If enabled secret should be procided in "x-secret" header for api requests.
 * @param {String} [options.pingInterval] If a ping request isn't made every 'pingInterval' seconds then thumbnail generation will stop. Defaults to disabled.
 * @param {Number} [options.logger] An object with `debug`, `info`, `warn` and `error` functions, or null, to disable logging.
 * @param {Object} [simpleThumbnailGeneratorOptions] Default configuraton for `ThumbnailGenerator`.
 * @param {Object} [thumbnailGeneratorOptions] Default configuraton for `SimpleThumbnailGenerator`. Note the temp directory will be automatically generated and managed if not provided.
 */
function ThumbnailGeneratorService(options, simpleThumbnailGeneratorOptions, thumbnailGeneratorOptions) {
	options = options || {};
	
	this._simpleThumbnailGeneratorOptions = simpleThumbnailGeneratorOptions || {};
	this._thumbnailGeneratorOptions = thumbnailGeneratorOptions || {};

	if (typeof(options.logger) === "undefined") {
		this._logger = Logger.get('ThumbnailGeneratorService');
	}
	else {
		if (options.logger === null) {
			this._logger = nullLogger;
		}
		else {
			this._logger = options.logger;
		}
	}

	this._port = options.port || 8080;
	this._secret = options.secret || null;
	this._pingInterval = options.pingInterval || null;
	this._outputDir = this._thumbnailGeneratorOptions.outputDir;
	this._tempDir = this._thumbnailGeneratorOptions.tempDir || null;
	this._destroyed = false;
	// generators by id
	this._generators = {};
	this._app = null;
	this._pingTimeoutIds = {};
	this._initTempDir().then(() => {
		if (this._destroyed) {
			return;
		}
		this._createServer();
		this._logger.debug("Loaded and listening on "+this._port+".");
	}).catch((err) => {
		throw err;
	});
}

/**
 * Destroy the server.
 */
ThumbnailGeneratorService.prototype.destroy = function() {
	if (this._destroyed) {
		return;
	}
	this._destroyed = true;
	Object.keys(this._generators).forEach((id) => {
		this._generators[id].destroy();
	});
	this._generators = {};
	this._app && this._app.close();
};

ThumbnailGeneratorService.prototype._initTempDir = function() {
	if (this._tempDir) {
		// temp dir provided. Don't touch, use as is.
		return Promise.resolve();
	}

	var tempDir = utils.getTempDir();
	this._logger.debug("Initializing temp directory.");

	return utils.ensureExists(tempDir).then(() => {
		return utils.emptyDir(tempDir);
	}).then(() => {
		this._tempDir = tempDir;
		this._logger.debug("Temp directory initialized.", tempDir);
	});
};

ThumbnailGeneratorService.prototype._createServer = function() {
	var app = express();
	app.use(bodyParser.urlencoded({ extended: false }));

	app.all('*', (req, res, next) => {
		if (!this._secret || (req.headers["x-secret"] && req.headers["x-secret"] === this._secret)) {
			next();
		}
		else {
			this._logger.debug("Request denied. Invalid secret.");
			res.status(403).send({ error: 'Invalid secret.' });
		}
	});

	app.post('/v1/start', (req, res) => {
		var url = req.body.url || null;
		if (!url) {
			throw new Error("URL required.");
		}
		var options = {
			playlistUrl: url
		};
		// thumbnailWidth and thumbnailHeight should be used
		// width and height for backwards compatibility (#9)
		var width = req.body.thumbnailWidth || req.body.width;
		var height = req.body.thumbnailHeight || req.body.height;
		width && (options.width = parseInt(width));
		height && (options.height = parseInt(height));
		req.body.interval && (options.interval = parseInt(req.body.interval));
		req.body.initialThumbnailCount && (options.initialThumbnailCount = parseInt(req.body.initialThumbnailCount));
		req.body.targetThumbnailCount && (options.targetThumbnailCount = parseInt(req.body.targetThumbnailCount));

		var id = this._createGenerator(options);
		res.send({
			id: id
		});
	});

	app.get('/v1/generators/:id', (req, res) => {
		var id = req.params.id;
		var generator = this._generators[id];
		if (!generator) {
			res.status(404).send({ error: 'Generator does not exist.' });
			return;
		}
		this._schedulePingTimeout(id, generator);
		res.send({
			ended: generator.hasPlaylistEnded()
		});
	});

	app.delete('/v1/generators/:id', (req, res) => {
		var id = req.params.id;
		var generator = this._generators[id];
		if (!generator) {
			res.status(404).send({ error: 'Generator does not exist.' });
			return;
		}
		generator.destroy();
		delete this._generators[id];
		if (this._pingInterval) {
			clearTimeout(this._pingTimeoutIds[id]);
			delete this._pingTimeoutIds[id];
		}
		res.send("Deleted.");
	});

	app.listen(this._port, "0.0.0.0");
	this._app = app;
};

ThumbnailGeneratorService.prototype._createGenerator = function(options) {
	var id = this._generateId();
	var thumbnailGeneratorOptions = Object.assign({}, this._thumbnailGeneratorOptions, options, {
		tempDir: this._tempDir,
		outputNamePrefix: id
	});
	var simpleThumbnailGeneratorOptions = Object.assign({}, this._simpleThumbnailGeneratorOptions, {
		manifestFileName: this._generateManifestFileName(id)
	});
	var generator = new SimpleThumbnailGenerator(simpleThumbnailGeneratorOptions, thumbnailGeneratorOptions);
	this._addListeners(id, generator);
	this._generators[id] = generator;
	this._schedulePingTimeout(id, generator);
	return id;
};

ThumbnailGeneratorService.prototype._schedulePingTimeout = function(id, generator) {
	if (!this._pingInterval) {
		// disabled
		return;
	}
	if (typeof(this._pingTimeoutIds[id]) !== "undefined") {
		// reset ping timeout
		clearTimeout(this._pingTimeoutIds[id]);
	}
	this._pingTimeoutIds[id] = setTimeout(() => {
		generator.destroy();
		delete this._generators[id];
		delete this._pingTimeoutIds[id];
		this._logger.debug("Generator destroyed because ping missed.", id);
	}, this._pingInterval * 1000);
};

ThumbnailGeneratorService.prototype._addListeners = function(id, generator) {
	var emitter = generator.getEmitter();

	emitter.on("error", (err) => {
		this._logger.error("Generator error.", id, err.stack);
		delete this._generators[id];
	});

	emitter.on("finished", () => {
		this._logger.debug("Generator finished.", id);
		delete this._generators[id];
	});
};

ThumbnailGeneratorService.prototype._generateManifestFileName = function(id) {
	return "thumbnails-"+id+".json";
};

ThumbnailGeneratorService.prototype._generateId = function() {
	var id = null;
	do {
		id = crypto.createHash("sha1").update(crypto.randomBytes(256).toString()).digest("hex");
	} while(this._generators[id]);
	return id;
};


module.exports = ThumbnailGeneratorService;
