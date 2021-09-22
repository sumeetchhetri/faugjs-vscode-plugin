const statik = require('node-static');
const http = require('http');
const stoppable = require('stoppable');
const {parentPort} = require("worker_threads");

let server, location;

parentPort.on("message", data => {
	if(data.type==1) {
		location = new statik.Server(data.dirPath);
		server = stoppable(http.createServer(function (request, response) {
			request.addListener('end', function () {
				location.serve(request, response);
			}).resume();
		}).listen(8087));
		parentPort.postMessage(data);
	} else {
		if(server) {
			server.stop();
			server = undefined;
			location = undefined;
		}
		parentPort.postMessage(data);
	}
});
