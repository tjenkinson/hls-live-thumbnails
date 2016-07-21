var fs = require("fs");
var path = require("path");
var os = require("os");

function emptyDir(dirPath) {
	return readdir(dirPath).then((files) => {
		var promises = [];
		files.forEach((file) => {
			var fullPath = path.join(dirPath, file);
			promises.push(stat(fullPath).then((stats) => {
				if (stats.isFile()) {
					return unlink(fullPath);
				}
				else if (stats.isDirectory()) {
					return emptyDir(fullPath).then(() => {
						// dir is now empty
						// remove it
						return rmdir(fullPath);
					});
				}
				else {
					throw new Error("Can't handle this type.");
				}
			}));
		});
		return Promise.all(promises);
	});
}

function readdir(dir) {
	return new Promise((resolve, reject) => {
		fs.readdir(dir, (err, files) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(files);
		});
	});
}

function mkdir(dir) {
	return new Promise((resolve, reject) => {
		fs.mkdir(dir, (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}

function stat(file) {
	return new Promise((resolve, reject) => {
		fs.stat(file, (err, stats) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(stats);
		});
	});
}

function exists(file) {
	return new Promise((resolve, reject) => {
		fs.stat(file, (err, stats) => {
			if (err) {
				if (err.code == 'ENOENT') {
					resolve(false);
				}
				else {
					reject(err);
				}
			}
			resolve(true);
		});
	});
}

function ensureExists(dir) {
	return exists(dir).then((exists) => {
		if (!exists) {
			return mkdir(dir);
		}
	});
}


function unlink(file) {
	return new Promise((resolve, reject) => {
		fs.unlink(file, (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}

function verifiedUnlink(file) {
	return unlink(file).catch((err) => {
		// sometimes it throws an error even but still deletes the file for some reason
		// check if the file has actually gone
		return exists(file).then((exists) => {
			if (exists) {
				// it did actually fail
				throw err;
			}
		});
	});
}

function rmdir(dir) {
	return new Promise((resolve, reject) => {
		fs.rmdir(dir, (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}

function writeFile(file, data, options) {
	options = options || {};
	return new Promise((resolve, reject) => {
		fs.writeFile(file, data, options, (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}

// http://stackoverflow.com/a/14387791
function copy(src, dest) {
	return new Promise((resolve, reject) => {
		var cbCalled = false;
		var rd = fs.createReadStream(src);
		rd.on("error", (err) => {
			done(err);
		});
		var wr = fs.createWriteStream(dest);
		wr.on("error", (err) => {
			done(err);
		});
		wr.on("close", () => {
			done();
		});
		rd.pipe(wr);

		function done(err) {
			if (!cbCalled) {
				cbCalled = true;
				!err ? resolve() : reject(err);
			}
		}
	});
}

function rename(src, dest) {
	return new Promise((resolve, reject) => {
		fs.rename(src, dest, (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}

// try rename(), and if fails (ie different drive), copy then delete
function move(src, dest) {
	return rename(src, dest).catch((err) => {
		// try copying
		return copy(src, dest).then(() => {
			// delete source
			return unlink(src);
		});
	});
}

function getTempDir() {
	return path.join(os.tmpdir(), 'hls-live-thumbnails');
}

module.exports = {
	emptyDir: emptyDir,
	unlink: unlink,
	mkdir: mkdir,
	verifiedUnlink: verifiedUnlink,
	stat: stat,
	exists: exists,
	ensureExists: ensureExists,
	writeFile: writeFile,
	copy: copy,
	rename: rename,
	move: move,
	getTempDir: getTempDir
};
