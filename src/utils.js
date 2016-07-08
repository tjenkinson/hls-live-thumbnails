var fs = require("fs");

function emptyDir(dirPath) {
	return readdir(dirPath).then((files) => {
		var promises = [];
		files.forEach((file) => {
			stat(file).then((stats) => {
				if (stats.isFile()) {
					promises.push(unlink(file));
				}
				else if (stats.isDirectory()) {
					promises.push(emptyDir(file).then(() => {
						// dir is now empty
						// remove it
						return rmdir(file);
					}));
				}
				else {
					throw new Error("Can't handle this type.");
				}
			});
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

module.exports = {
	emptyDir: emptyDir,
	unlink: unlink,
	mkdir: mkdir,
	verifiedUnlink: verifiedUnlink,
	stat: stat,
	exists: exists,
	writeFile
};