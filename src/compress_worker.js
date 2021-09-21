const {parentPort} = require("worker_threads");
const fgt = require('./faug-templatize.js');

parentPort.on("message", data => {
	//console.log("child:" + JSON.stringify(data));
	fgt.compressAll(data.dirPath, (by)=> {
		parentPort.postMessage({status: 'progress', by: by});
	});
	parentPort.postMessage({status: 'done'});
});
