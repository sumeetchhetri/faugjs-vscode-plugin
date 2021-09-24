(function () {
    const vscode = acquireVsCodeApi();

	// Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
		//console.log(JSON.stringify(event.data));
        const msg = event.data; // The json data that the extension sent
        document.location = "#" + msg.func.toLowerCase();
    });
}());