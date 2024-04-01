import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import FastGlob = require("fast-glob");
import * as cr from 'crypto';
import * as vm from 'vm';
import * as jsb from 'js-beautify';
import { Worker, isMainThread, parentPort } from 'worker_threads';
import * as esprima from 'esprima';
import * as estree from 'estree';
import * as csso from 'csso';
const minify = require('@node-minify/core');
const gcc = require('@node-minify/google-closure-compiler');
const uglifyjs = require('@node-minify/terser');
const sqwish = require('@node-minify/sqwish');
const noCompress = require('@node-minify/no-compress');
const { DOMParser } = require('xmldom');
import * as xpath from 'xpath-ts';
const parseJson = require('parse-json');
const XRegExp = require('xregexp');
let fjsdocpanel: vscode.WebviewPanel | undefined = undefined;
let fjspanelword: string | undefined= undefined;

let compressInProgress = false;
let flogger: vscode.OutputChannel;
let httpWorker: Worker;

function log(msg: string) {
	if(flogger) {
		flogger.appendLine(msg);
	} else {
		console.log(msg);
	}
}

//https://stackoverflow.com/questions/62453615/vscode-open-a-file-in-a-specific-line-number-using-js
export function activate(context: vscode.ExtensionContext) {
	const worker = new Worker(context.asAbsolutePath("compress_worker.js"));

	const fjstemplatedgcoll = vscode.languages.createDiagnosticCollection("fjstmpl");
	context.subscriptions.push(fjstemplatedgcoll);

	subscribeToDocumentChanges(context, fjstemplatedgcoll);

	//https://github.com/mjcrouch/vscode-activator/blob/master/package.json
	vscode.window.withProgress({
		location: vscode.ProgressLocation.Window,
		cancellable: false,
		title: 'Setting up faugjs'
	}, async (progress) => {
		progress.report({increment: 0});

		loadExtensions();

		if(vscode.workspace.workspaceFolders === undefined) return;

		let fjscPaths: Array<string> = [] as Array<string>;
		let isMulti = false;
		const fjscPercs: Record<string, number> = {} as Record<string, number>;
		let totalfjslens = 0;
		
		const writeToChannel = !fs.existsSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, ".console"));
		if(writeToChannel) {
			flogger = vscode.window.createOutputChannel("faugjs");
			flogger.show();
		}

		const fappspath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, ".faugjs-apps.json");
		if(fs.existsSync(fappspath)) {
			fjscPaths = JSON.parse(fs.readFileSync(fappspath, "utf8"));
			isMulti = true;
			log("[main] [INFO]: Found multiple config locations => " + fjscPaths.join(" "));
			for(const fjscp of fjscPaths) {
				const lst = await FastGlob(['**.json', '**.js'], { cwd: path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, fjscp) });
				fjscPercs[fjscp] = lst.length;
				totalfjslens += lst.length;
			}
		} else {
			fjscPaths.push("");
		}

		const stgJschFpLst1: Array<string> = [] as Array<string>;
		const stgJschFpLst2: Array<string> = [] as Array<string>;
		for(const fjscp of fjscPaths) {
			let pperc = fjscPercs[fjscp]/totalfjslens*100;

			let totalUnits = 0;
			let doneUnits = 0;
			let progressedUnits = 0;

			const fjs = new FaugJsConfigStore();
			resolveBasePath(fjs, fjscp, isMulti, stgJschFpLst1);

			try {
				const tmplMap: Record<string, any> = {};
				gatherTemplates(fjs.basePath!.fsPath, tmplMap);
				if (vscode.window.activeTextEditor) {
					const doc = vscode.window.activeTextEditor!.document;
					if (doc.uri.fsPath.endsWith(".html")) {
						validateFjsTemplate(fjstemplatedgcoll, 1);
					}
				}

				for(const key in tmplMap) {
					fjs.templateList[key.replace(/\/\//g, path.sep).replace(/\//g, path.sep)] = tmplMap[key];
				}
			} catch (error) {
				log("[main] [ERROR]: " + error.stack!);
			}

			fjs.configList.push(fjs.fjcuri!.fsPath);

			const fjsconfigs: Array<string> = [];
			fs.readdirSync(fjs.basePath!.fsPath).forEach(fn => {
				if(fn.startsWith("fjs-config_") && fn.endsWith(".json")) {
					if(!fn.endsWith("_t.json") && !fn.endsWith("_s.json") && !fn.endsWith("_prod.json")) {
						fjsconfigs.push(fn);
						const uri = vscode.Uri.joinPath(fjs.basePath!, fn);
						fjs.configList.push(uri.fsPath);
						stgJschFpLst1.push("/"+fjscp+"/"+fn);
					}
				}
			});

			const document = await vscode.workspace.openTextDocument(fjs.fjcuri!);
			const tree = JSON.parse(document.getText());

			totalUnits += fjsconfigs.length + 1;
			if(tree["modules"] && tree["modules"].length>0) {
				totalUnits += tree["modules"].length * 11;
			}

			gatherSchemaAndTemplateFiles(fjs, tree, stgJschFpLst2, fjscp);
			for(const fjsc of fjsconfigs) {
				const uri = vscode.Uri.joinPath(fjs.basePath!, fjsc);
				const document = await vscode.workspace.openTextDocument(uri);
				const mtree = JSON.parse(document.getText());
				gatherSchemaAndTemplateFiles(fjs, mtree, stgJschFpLst2, fjscp);
			}
			totalUnits += Object.keys(fjs.schemaList).length;

			let start = process.hrtime();
			log("[main] [INFO]: Parse Config Files for location " + fjs.basePath!.fsPath);
			let symbols = await loadSymbolsForFile(fjs.fjcuri!, true);
			fjs.parseJsonFile(fjs.fjcuri!, symbols);
			//log("[main] [INFO]: " + JSON.stringify(fjs.jsonFilesSymbolList));
			doneUnits += 1;
			let percent = doneUnits/totalUnits*pperc;
			if(percent>1) {
				progress.report({increment: percent});
				progressedUnits = percent;
				//log("[main] [INFO]: " + doneUnits+"/"+totalUnits+" => "+percent);
			}

			for(const fjsc of fjsconfigs) {
				const uri = vscode.Uri.joinPath(fjs.basePath!, fjsc);
				const symbols = await loadSymbolsForFile(uri, false);
				fjs.parseJsonFile(uri, symbols);
				doneUnits += 1;
				percent = doneUnits/totalUnits*pperc;
				if(percent-progressedUnits>1) {
					progress.report({increment: percent-progressedUnits});
					progressedUnits = percent;
					//log("[main] [INFO]: " + doneUnits+"/"+totalUnits+" => "+percent);
				}
			}
			let stop = process.hrtime(start);
			log(`[main] [INFO]: Parse Config Files for location ${fjs.basePath!.fsPath} completed in ${(stop[0] * 1e9 + stop[1])/1e9} seconds`);

			start = process.hrtime();
			log("[main] [INFO]: Parse Module Files for location " + fjs.basePath!.fsPath);
			const uri = vscode.Uri.joinPath(fjs.basePath!, "faug-min.js");
			symbols = await loadSymbolsForFile(uri, true);
			fjs.parseJsFile(uri, symbols);
			doneUnits += 11;
			percent = doneUnits/totalUnits*pperc;
			if(percent-progressedUnits>1) {
				progress.report({increment: percent-progressedUnits});
				progressedUnits = percent;
				//log("[main] [INFO]: " + doneUnits+"/"+totalUnits+" => "+percent);
			}

			if(tree["modules"] && tree["modules"].length>0) {
				for (const mod of tree["modules"]) {
					const uri = vscode.Uri.joinPath(fjs.basePath!, mod);
					const symbols = await loadSymbolsForFile(uri, false);
					fjs.parseJsFile(uri, symbols);
					doneUnits += 11;
					percent = doneUnits/totalUnits*pperc;
					if(percent-progressedUnits>1) {
						progress.report({increment: percent-progressedUnits});
						progressedUnits = percent;
						//log("[main] [INFO]: " + doneUnits+"/"+totalUnits+" => "+percent);
					}
				}
				
				fjs.jsrefcontents = "const jsdom = require('jsdom');const dom = new jsdom.JSDOM('<!DOCTYPE html><html><body></body></html>');const jquery = require('jquery')(dom.window);const window=dom.window;const document=dom.window.document;window['onlyFaugCore']=true;window['noFaugExtension']=true;const $=jquery;\n"
				fjs.jsrefcontents += fs.readFileSync(context.asAbsolutePath("faug-min.js"), 'utf-8');
				fjs.jsrefcontentslines = fjs.jsrefcontents.split("\n").length;
				for (const jsf in fjs.jsFilesFuncList) {
					if(jsf.endsWith("faug-min.js") || jsf.endsWith("faugn.js")) continue;
					const syms = fjs.jsFilesFuncList[jsf];
					for(const symn in syms) {
						if(syms[symn][""].kind==vscode.SymbolKind.Function && symn!="<function>") {
							fjs.jsrefcontents += "function " + symn +"() {}\n";
							fjs.jsrefcontentslines++;
						} else if(syms[symn][""].kind==vscode.SymbolKind.Variable || syms[symn][""].kind==vscode.SymbolKind.Constant) {
							if(symn=="Fg") {
								fjs.jsrefcontents += "var " + symn +" = Faug;\n";
								fjs.jsrefcontentslines++;
								continue;
							}
							fjs.jsrefcontents += "var " + symn +" = {\n";
							fjs.jsrefcontentslines++;
							for(const csyn in syms[symn]) {
								if(csyn!="" && csyn!="<function>") {
									if(fjs.jsrefcontents.charAt(fjs.jsrefcontents.length-1)!='\n') {
										fjs.jsrefcontents += "\n";
										fjs.jsrefcontentslines++;
									}
									fjs.jsrefcontents += "\t" + csyn +": function() {},";
								}
							}
							if(fjs.jsrefcontents.charAt(fjs.jsrefcontents.length-1)==',') {
								fjs.jsrefcontents = fjs.jsrefcontents.substring(0, fjs.jsrefcontents.length-1) + "\n";
								fjs.jsrefcontentslines++;
							}
							fjs.jsrefcontents += "};\n";
							fjs.jsrefcontentslines++;
						}
					}
				}

				for(const jsf of tree["modules"]) {
					fjs.moduleList.push(jsf.replace(/\/\//g, path.sep).replace(/\//g, path.sep));
				}
			}
			
			stop = process.hrtime(start);
			log(`[main] [INFO]: Parse Module Files for location ${fjs.basePath!.fsPath} completed in ${(stop[0] * 1e9 + stop[1])/1e9} seconds`);
			
			start = process.hrtime();
			log("[main] [INFO]: Parse Schema Files for location " + fjs.basePath!.fsPath);
			if(fjs.schemaList) {
				for (const schname in fjs.schemaList) {
					const uri = vscode.Uri.file(fjs.schemaList[schname]);
					const symbols = await loadSymbolsForFile(uri, false);
					fjs.parseJsonFile(uri, symbols);
					doneUnits += 1;
					percent = doneUnits/totalUnits*pperc;
					if(percent-progressedUnits>1) {
						progress.report({increment: percent-progressedUnits});
						progressedUnits = percent;
						//log("[main] [INFO]: " + doneUnits+"/"+totalUnits+" => "+percent);
					}
				}
			}

			fjs.isReady = true;

			stop = process.hrtime(start);
			log(`[main] [INFO]: Parse Schema Files for location ${fjs.basePath!.fsPath} completed in ${(stop[0] * 1e9 + stop[1])/1e9} seconds`);
			
			log("[main] [INFO]: Found " + (fjsconfigs.length + 1) + " config files for location " + fjs.basePath!.fsPath);
			log("[main] [INFO]: Found " + fjs.moduleList.length + " module files for location " + fjs.basePath!.fsPath);
			log("[main] [INFO]: Found " + Object.keys(fjs.schemaList).length + " schema files for location " + fjs.basePath!.fsPath);
			log("[main] [INFO]: Found " + Object.keys(fjs.templateList).length + " template files for location " + fjs.basePath!.fsPath);
			log("[main] [INFO]: Found " + Object.keys(tree["router"]!["routes"]!).length + " routes for location " + fjs.basePath!.fsPath);
			log("[main] [INFO]: Found " + Object.keys(tree["globals"]!).length + " globals for location " + fjs.basePath!.fsPath);		
		}

		progress.report({increment: 100});

		const id1 = cr.createHash('sha512').update(vscode.workspace.workspaceFolders[0].uri.fsPath+"_1").digest('hex');
		const id2 = cr.createHash('sha512').update(vscode.workspace.workspaceFolders[0].uri.fsPath+"_2").digest('hex');

		let stgsJson: Array<any> = [] as Array<any>;
		if(vscode.workspace.getConfiguration().has("json.schemas")) {
			stgsJson = vscode.workspace.getConfiguration().get("json.schemas")!;
		}

		let ecuri = vscode.Uri.file(context.asAbsolutePath("faug-config-schema.json"));
		let esuri = vscode.Uri.file(context.asAbsolutePath("faug-schema-schema.json"));

		if(stgsJson.length==0) {
			stgsJson.push({"$id": id1, fileMatch: stgJschFpLst1, schema: JSON.parse(fs.readFileSync(ecuri.fsPath, "utf8"))});
			stgsJson.push({"$id": id2, fileMatch: stgJschFpLst2, schema: JSON.parse(fs.readFileSync(esuri.fsPath, "utf8"))});
		} else {
			let found = false;
			for(let i=0;i<stgsJson.length;i++) {
				if(stgsJson[i]["$id"]==id1) {
					found = true;
					stgsJson[i].fileMatch = stgJschFpLst1;
					stgsJson[i].schema = JSON.parse(fs.readFileSync(ecuri.fsPath, "utf8"));
				} else if(stgsJson[i]["$id"]==id2) {
					stgsJson[i].fileMatch = stgJschFpLst2;
					stgsJson[i].schema = JSON.parse(fs.readFileSync(esuri.fsPath, "utf8"));
				}
			}
			if(!found) {
				stgsJson.push({"$id": id1, fileMatch: stgJschFpLst1, schema: JSON.parse(fs.readFileSync(ecuri.fsPath, "utf8"))});
				stgsJson.push({"$id": id2, fileMatch: stgJschFpLst2, schema: JSON.parse(fs.readFileSync(esuri.fsPath, "utf8"))});
			}
		}
		vscode.workspace.getConfiguration().update("json.schemas", stgsJson);

		vscode.window.showInformationMessage("Faugjs setup completed");
	});
	
	function subscribeToDocumentChanges(context: vscode.ExtensionContext, emojiDiagnostics: vscode.DiagnosticCollection): void {
		context.subscriptions.push(
			vscode.workspace.onDidSaveTextDocument(async (doc) => {
				const docact = vscode.window.activeTextEditor!.document;
				if (docact.uri.fsPath == doc.uri.fsPath && doc.uri.fsPath.endsWith(".html")) {
					validateFjsTemplate(fjstemplatedgcoll, 1);
				} else if(docact.uri.fsPath == doc.uri.fsPath && doc.uri.fsPath.endsWith(".js")) {
					const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc);
					if(fjs && fjs.isReady && fjs.isModule(doc.uri)) {
						const symbols = await loadSymbolsForFile(doc.uri, false);
						fjs.parseJsFile(doc.uri, symbols);
					}
				} else if(docact.uri.fsPath == doc.uri.fsPath && doc.uri.fsPath.endsWith(".json")) {
					const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc)!;
					if(fjs && fjs.isReady) {
						let isfjsconfig = fjs.configList.indexOf(doc.uri.fsPath)!=-1;
						if (isfjsconfig) {
							//TODO
						} else if(fjs.isSchema(doc.uri.fsPath)) {
							const symbols = await loadSymbolsForFile(doc.uri, false);
							fjs.parseJsonFile(doc.uri, symbols);
						}
					}
				}
			})
		);

		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(te => {
				if (te!.document.uri.fsPath.endsWith(".html")) {
					validateFjsTemplate(fjstemplatedgcoll, 1);
				}
			})
		);
	
		/*context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument(e => {
				if (e && e.document.uri.fsPath.endsWith(".html")) {
					validateFjsTemplate(fjstemplatedgcoll, 1);
				}
			})
		);*/
	
		context.subscriptions.push(
			vscode.workspace.onDidCloseTextDocument(doc => fjstemplatedgcoll.delete(doc.uri))
		);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('faugjs.template.validate', () => {
			validateFjsTemplate(fjstemplatedgcoll, 2);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('faugjs.template.code', () => {
			validateFjsTemplate(fjstemplatedgcoll, 3);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('faugjs.template.format', () => {
			formatTemplate(fjstemplatedgcoll, 1);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('faugjs.template.onlyhtml', () => {
			formatTemplate(fjstemplatedgcoll, 2);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('faugjs.template.onlyjs', () => {
			formatTemplate(fjstemplatedgcoll, 3);
		})
	);

	function getNonce() {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}
	function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
		return {
			enableCommandUris: true,
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'fjsdoc'))]
		};
	}
	function setupFjsDoc() {
		/*
		Once faugjs doc is updated, please replace this in the generated documentation html file
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${safeurl}; img-src ${safeurl} https:; script-src 'nonce-${nonce}';">
			<link href='${baseurl}/assets/bass.css' rel='stylesheet'>
			<link href='${baseurl}/assets/style.css' rel='stylesheet'>
			<link href='${baseurl}/assets/github.css' rel='stylesheet'>
			<link href='${baseurl}/assets/split.css' rel='stylesheet'>
			<script nonce="${nonce}" src="${baseurl}/index.js"></script>
		*/
		const uri = fjsdocpanel!.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'fjsdoc'));
		let data = fs.readFileSync(path.join(context.extensionPath, 'fjsdoc', 'index.html'), 'utf8');
		data = data.replace(/\$\{baseurl\}/g, uri.toString());
		data = data.replace(/\$\{safeurl\}/g, fjsdocpanel!.webview.cspSource);
		data = data.replace(/\$\{nonce\}/g, getNonce());
		fjsdocpanel!.webview.html = data;
		fjsdocpanel!.onDidDispose(() => {
			log("[main] [INFO]: Closed faugjs documentation");
			fjsdocpanel!.dispose();
			fjsdocpanel = undefined;
		});
		if(fjspanelword) {
			fjsdocpanel!.webview.postMessage({ func: fjspanelword });
			fjspanelword = undefined;
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('faugjs.docs', () => {
			if(fjsdocpanel) {
				fjsdocpanel.reveal();
				vscode.window.showInformationMessage('faugjs documentation is already open');
				return;
			}
			fjsdocpanel = vscode.window.createWebviewPanel(
				'faugjs.doc',
				'faugjs Documentation',
				vscode.ViewColumn.One,
				{
					enableCommandUris: true,
					enableScripts: true,
					localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'fjsdoc'))]
				}
			);
			setupFjsDoc();
		})
	);

	if (vscode.window.registerWebviewPanelSerializer) {
		vscode.window.registerWebviewPanelSerializer('faugjs.doc', {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				//log(`[main] [INFO]: Got state: ${state}`);
				webviewPanel.webview.options = getWebviewOptions(context.extensionUri);
				fjsdocpanel = webviewPanel;
				setupFjsDoc();
			}
		});
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('faugjs.compress', () => {
			const doc = vscode.window.activeTextEditor!.document;
			if(!doc) {
				return;
			}
			const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc);
			if(fjs) {
				if(compressInProgress) {
					vscode.window.showInformationMessage('Compressing faujs app [' + fjs.fjspath + '] already in progress');
					return;
				}
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					cancellable: false,
					title: 'Compressing faujs app [' + fjs.fjspath + ']'
				}, progress => {
					progress.report({increment: 0});
					return new Promise((resolve) => {
						compressInProgress = true;
						worker.postMessage({dirPath: fjs.basePath!.fsPath});
						worker.on("message", result => {
							//log("[main] [INFO]: parent: " + JSON.stringify(result));
							if(result.type==1) {
								if(result.status=='done') {
									progress.report({increment: 100});
									vscode.window.showInformationMessage('Compressing faujs app [' + fjs.fjspath + '] completed');
									resolve(null);
									compressInProgress = false;
								} else if(result.status=='progress') {
									progress.report({increment: Math.floor(result.by)});
								}
							} else {
								log("[compress_worker] ["+result.stype+"]:" + result.message);
							}
						});
						
						worker.on("error", error => {
							//log("[main] [INFO]: parent-error: " + error);
							progress.report({increment: 100});
							vscode.window.showInformationMessage('Compressing faujs app [' + fjs.fjspath + '] failed');
							log("[main] [ERROR]: " + error.stack!);
							resolve(null);
							compressInProgress = false;
						});
						//Without worker thread
						/*try {
							compressAll(fjs.basePath!.fsPath, (by: number)=> {
								progress.report({increment: Math.floor(by)});
							});
						} catch (error) {
							log("[main] [ERROR]: " + error.stack!);
						}
						compressInProgress = false;*/
					});
				});
			} else if(fjs) {
				vscode.window.showInformationMessage("Faugjs setup in progress, please try after setup is complete..");
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('faugjs.serve', () => {
			const doc = vscode.window.activeTextEditor!.document;
			if(!doc) {
				return;
			}
			const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc);
			if(fjs) {
				if(httpWorker) {
					vscode.window.showInformationMessage('Already serving app [' + fjs.fjspath + ']');
					return;
				}
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					cancellable: true,
					title: 'Serving app [' + fjs.fjspath + ']'
				}, (progress, token) => {
					token.onCancellationRequested(() => {
						httpWorker.postMessage({type: 2});
					});

					progress.report({increment: 0});
					setTimeout(() => {
						progress.report({increment: 20});
					}, 1000);
		
					setTimeout(() => {
						progress.report({increment: 20});
					}, 2000);
		
					setTimeout(() => {
						progress.report({increment: 20});
					}, 3000);
					return new Promise((resolve) => {
						httpWorker = new Worker(context.asAbsolutePath("http_worker.js"));
						httpWorker.postMessage({type: 1, dirPath: fjs.basePath!.fsPath});
						httpWorker.on("message", result => {
							if(result.type==1) {
								progress.report({increment: 40});
								vscode.window.showInformationMessage('Started serving app [' + fjs.fjspath + ']');
							} else {
								vscode.window.showInformationMessage('Stopped serving app [' + fjs.fjspath + ']');
								resolve(null);
							}
						});
					});
				});
			}
		})
	);

	//https://developpaper.com/the-function-of-jump-to-definition-automatic-completion-and-hover-prompt-of-vscode-plug-in-development-strategy/
	var defJsProvider = vscode.languages.registerDefinitionProvider({scheme: 'file', language: 'javascript'}, {
		//log("[main] [INFO]: in hover")
		provideDefinition(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
			const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc)!;
			if(fjs) {
				return fjs.findDefinition(doc, position, false);
			}
		}
	});
	context.subscriptions.push(defJsProvider);

	var complJsProvider = vscode.languages.registerCompletionItemProvider({scheme: 'file', language: 'javascript'}, {
		//log("[main] [INFO]: in hover")
		provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.CompletionItem[] | undefined {
			const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc)!;
			if(!fjs.isModule(doc.uri)) {
				vscode.window.showInformationMessage("Faugjs setup in progress, please try after modules (js files) are initialized..");
				return undefined;
			}
			const [word1, word2] = getWords(doc, position);
			//log("[main] [INFO]: " + word1 + " " + word2);
			if(word2.length<3) return undefined;

			const clist: vscode.CompletionItem[] = [] as vscode.CompletionItem[];
			for(const filename in fjs.jsFilesFuncList) {
				let w2lst;
				if(word1 && fjs.jsFilesFuncList[filename] && fjs.jsFilesFuncList[filename][word1]) {
					w2lst = fjs.jsFilesFuncList[filename][word1];
				} else if(fjs.jsFilesFuncList[filename]) {
					w2lst = fjs.jsFilesFuncList[filename];
				}

				if(w2lst) {
					for(const symn in w2lst) {
						if(symn.startsWith(word2)) {
							const cc = new vscode.CompletionItem(symn);
							switch(w2lst[symn][""].kind) {
								case vscode.SymbolKind.Function:
									cc.kind = vscode.CompletionItemKind.Function;
									break;
								case vscode.SymbolKind.Class:
									cc.kind = vscode.CompletionItemKind.Class;
									break;
								case vscode.SymbolKind.Property:
									cc.kind = vscode.CompletionItemKind.Property;
									break;
								case vscode.SymbolKind.Field:
									cc.kind = vscode.CompletionItemKind.Field;
									break;
								case vscode.SymbolKind.Method:
									cc.kind = vscode.CompletionItemKind.Method;
									break;
								case vscode.SymbolKind.Variable:
									cc.kind = vscode.CompletionItemKind.Variable;
									break;
								case vscode.SymbolKind.Constant:
									cc.kind = vscode.CompletionItemKind.Constant;
									break;
								default:
									cc.kind = vscode.CompletionItemKind.Unit;
									break;
							}
							cc.detail = "Found in " + filename;
							cc.sortText = "a";
							/*cc.filterText = filename+";";
							if(word1) {
								cc.filterText = word1;
							}*/
							clist.push(cc);
						}
					}
					if(word1) {
						break;
					}
				}
			}
			//log("[main] [INFO]: " + JSON.stringify(clist));
			return clist;
		}, resolveCompletionItem(cc: vscode.CompletionItem, token) {
			/*const filename = cc.filterText!.substring(0, cc.filterText!.indexOf(";"));
			let word1 = undefined;
			const word2 = cc.label;
			if(cc.filterText!.length>(filename.length+1)) {
				word1 = cc.filterText!.substring(cc.filterText!.indexOf(";")+1);
			}
			let w2lst;
			if(word1) {
				w2lst = fjs.jsFilesFuncList[filename][word1];
			} else {
				w2lst = fjs.jsFilesFuncList[filename];
			}*/
			return null;
		}
	});
	context.subscriptions.push(complJsProvider);

	var defJsonProvider = vscode.languages.registerDefinitionProvider({ scheme: 'file', language: 'json' }, {
		provideDefinition(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
			try {
				const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc)!;
				if(!fjs) {
					return undefined;
				}
				if(!fjs.isReady) {
					vscode.window.showInformationMessage("Faugjs setup in progress, please try after setup is complete..");
					return undefined;
				}
				let isfjsconfig = fjs.configList.indexOf(doc.uri.fsPath)!=-1;
				if (isfjsconfig) {
					let ld = fjs.jsonFilesSymbolList[doc.uri.fsPath+"_linesinfo"][position.line];
					if(ld && /template|func|op|schemaName|viewerId/.test(ld!.name)) {
						return handleTemFuncCrudOps(fjs, doc, position, ld);
					} else {
						const wr = doc.getWordRangeAtPosition(position)!;
						let word = doc.getText(wr);
						if(!ld!.detail) {
							let cnt = position.line;
							while(cnt>0) {
								ld = fjs.jsonFilesSymbolList[doc.uri.fsPath+"_linesinfo"][--cnt];
								if(ld && ld!.kind==vscode.SymbolKind.Array) {
									if(word.endsWith(".json\"")) {
										return handleTemFuncCrudOps(fjs, doc, position, {name: "__sf__", detail: word.substring(1, word.length-1)});
									} else if(word.endsWith(".js\"")) {
										return handleTemFuncCrudOps(fjs, doc, position, {name: "__mf__", detail: word.substring(1, word.length-1)});
									} else if(word.endsWith(".html\"")) {
										return handleTemFuncCrudOps(fjs, doc, position, {name: "templateFile", detail: word.substring(1, word.length-1)});
									}
									break;
								}
							}
						}
					} 
				} else if(fjs.isSchema(doc.uri.fsPath)) {
					let ld = fjs.jsonFilesSymbolList[doc.uri.fsPath+"_linesinfo"][position.line];
					if(isPossibleFuncLabel(ld) || isTemplateLabel(ld) || isSchemaLabel(ld)) {
						return handleTemFuncCrudOps(fjs, doc, position, ld);
					} else if(ld.name=="target") {
						let props = fjs.jsonFilesSymbolList[doc.uri.fsPath]["properties"];
						if(props && props[ld.detail]) {
							return props[ld.detail][""]["location"];
						}
					} else if(ld.name=="fromVar") {
						return searchWithRegex(fjs, ld.detail, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
					} else if(ld.name=="routeTo") {
						return getRouteLocation(fjs, ld, ld.detail);
					} else if(ld.detail && (ld.detail.startsWith("%%Fg.g(") || ld.detail.startsWith("%%Faug.g("))) {
						let vname = undefined;
						if(ld.detail.startsWith("%%Fg.g(")) {
							vname = ld.detail.substring(7, ld.detail.indexOf(")"));
							//log("[main] [INFO]: globals => "+vname);
						} else {
							vname = ld.detail.substring(9, ld.detail.indexOf(")"));
							//log("[main] [INFO]: globals => "+vname);
						}
						if(vname) {
							return searchWithRegex(fjs, vname, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
						}
					} else {
						let props = fjs.jsonFilesSymbolList[doc.uri.fsPath]["properties"];
						const wr = doc.getWordRangeAtPosition(position)!;
						let word = doc.getText(wr);
						if(word.startsWith("\"func:")) {
							return fjs.resolvePossibleFunction(doc, undefined, word.substring(6, word.length-1), position);
						} else if(word.indexOf("%%Fg.g")!=-1 || word.indexOf("%%Faug.g(")!=-1) {
							let vname = undefined;
							if(word.indexOf("%%Fg.g")!=-1) {
								vname = word.substring(word.indexOf("%%Fg.g")+7, word.indexOf(")", word.indexOf("%%Fg.g")+7));
							} else {
								vname = word.substring(word.indexOf("%%Faug.g")+9, word.indexOf(")", word.indexOf("%%Faug.g")+9));
							}
							if(vname) {
								//log("[main] [INFO]: globals_extract => "+vname);
								return searchWithRegex(fjs, vname, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
							}
						} else if(word.indexOf("gvar@")!=-1) {
							const vname = word.substring(word.indexOf("gvar@")+5);
							if(vname) {
								//log("[main] [INFO]: globals_extract => "+word);
								return searchWithRegex(fjs, vname, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
							}
							
						} else if(word.indexOf("<%")!=-1) {
							//log("[main] [INFO]: var_extract => "+word);
						} else if(props && props[word.substring(1, word.length-1)]) {
							return props[word.substring(1, word.length-1)][""]["location"];
						}
					}
				}
			} catch (error) {
				log("[main] [ERROR]: " + error.stack!);
			}
			return undefined;
		}
	});
	context.subscriptions.push(defJsonProvider);
}

const resolvePath = (filepath: string): string =>
{
	if (filepath[0] === '~')
	{
		const hoveVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
		return path.join(process.env[hoveVar], filepath.slice(1));
	}
	else
	{
		return path.resolve(filepath);
	}
};

const saveAndOpenNewTmpFile = (tname: string, fdata: string): void => {
	const tempdir = resolvePath(vscode.workspace.getConfiguration('createtmpfile').get('tmpDir') || os.tmpdir());
	const newFile = vscode.Uri.parse('untitled:' + path.join(tempdir, tname));
	vscode.workspace.openTextDocument(newFile).then(document => {
		const edit = new vscode.WorkspaceEdit();
		edit.insert(newFile, new vscode.Position(0, 0), fdata);
		return vscode.workspace.applyEdit(edit).then(success => {
			if (success) {
				vscode.window.showTextDocument(document);
			} else {
				vscode.window.showInformationMessage('Error!');
			}
		});
	});
}

function validateFjsTemplate(fjstemplatedgcoll: vscode.DiagnosticCollection, mode: number) {
	const doc = vscode.window.activeTextEditor!.document;
	const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc);
	const tname = fjs!.getTemplate(doc.uri.fsPath);
	if(fjs && tname && fjs.jsrefcontents) {
		let code = '';
		const type = fjs.templateList[tname];
		try {
			let tmplvars;
			if (type == 0) {
				tmplvars = {rows: [], options: {}};
				const out = faugX(fjs.basePath!.fsPath, {}, tname, tmplvars, false, false, true);
				code = out![3];
			} else if (type == 1 || type == 2) {
				tmplvars = {isTransient: false, elName: '', rows: [], selectedVal: '', details: '', vars: {}, options: {}};
				const out = faugX(fjs.basePath!.fsPath, {}, tname, tmplvars, false, false, true);
				code = out![3];
			} else if (type == 3 || type == 5) {
				tmplvars = fjs.templateList[tname][1];
				const out = faugX(fjs.basePath!.fsPath, {}, tname, tmplvars, false, false, true);
				code = out![3];
			} else if (type == 4) {
				tmplvars = fjs.templateList[tname][1];
				const out = faugX(fjs.basePath!.fsPath, {}, tname, tmplvars, false, true, true);
				code = out![3];
			}

			code = code.replace('return ____r_____.join("");', '');
			if(mode==3) {
				const fdata = jsb.js_beautify(code);
				saveAndOpenNewTmpFile(tname+'.js', fdata);
				return;
			}
			const excode = code;
			let isvalid = true;
			try {
				const exlines = fjs.jsrefcontentslines! + 1 + Object.keys(tmplvars).length + 1;
				code = fjs.jsrefcontents + "\n\n" + code;//jsb.js_beautify(code, { indent_size: 4, space_in_empty_paren: true });
				vm.runInNewContext(code, {require: require, console: console, arg: tmplvars}, {lineOffset: -exlines, filename: tname, displayErrors: true});
				fjstemplatedgcoll.set(doc.uri, []);
			} catch(e) {
				//log("[main] [ERROR]: " + e.stack);
				const ep = e.stack.toString().split("\n");
				if(ep[4].startsWith("SyntaxError") || /*ep[4].startsWith("ReferenceError") ||*/ ep[4].endsWith("is not a function")) {
					let li = ep[0].substring(ep[0].lastIndexOf(":")+1) * 1;
					//li -= (Object.keys(tmplvars).length + 1);
					/*if(ep[1].indexOf("____r_____.push(")!=-1) {
						li = li - 1;
					}*/
					const cdlines = excode.split("\n");
					let ix = li + Object.keys(tmplvars).length;
					while(ix>0) {
						let tl = cdlines[ix];
						let fl = false;
						if(tl.startsWith("____r_____.push(")) {
							tl = tl.substring(16);
							fl = true;
						}
						const mtc = /^\/\*([0-9]+)\*\//.exec(tl);
						if(mtc) {
							li = parseInt(mtc[1])*1;
							break;
						} else {
							if(fl) {
								ix--;
							} else {
								ix++;
							}
						}
					}
					const range = doc.lineAt(li-1).range;
					const diagnostic = new vscode.Diagnostic(range, ep[4], vscode.DiagnosticSeverity.Error);
					fjstemplatedgcoll.set(doc.uri, [diagnostic]);
					isvalid = false;
				} else {
					fjstemplatedgcoll.set(doc.uri, []);
				}
				//log("[main] [INFO]: " + ep[0]);
				//log("[main] [INFO]: " + ep[4]);
			}
			if(isvalid && mode==2) {
				vscode.window.showInformationMessage("VALID faugjs template -> " + tname);
			}
		} catch (error) {
			log("[main] [ERROR]: " + error.stack!);
		}
	} else {
		vscode.window.showInformationMessage("Faugjs is initializing, please wait...");
	}
}

function getRouteLocation(fjs: FaugJsConfigStore, ld: any, route: string) {
	const fjcuri = vscode.Uri.joinPath(fjs.basePath!, "fjs-config.json");
	let router = fjs.jsonFilesSymbolList[fjcuri.fsPath]["router"];
	if(router && router["routes"]) {
		for(const rkey in router["routes"]) {
			const rkeypre = rkey.indexOf("/")!=-1?rkey.substring(0, rkey.indexOf("/")):rkey;
			const ldpre = route.indexOf("/")!=-1?route.substring(0, route.indexOf("/")):route;
			if(ldpre==rkeypre) {
				return router["routes"][rkey][""]["location"];
			}
		}
		if(ld) {
			return router["routes"][ld.detail][""]["location"];
		}
	}
	return undefined;
}

function resolveBasePath(fjs: FaugJsConfigStore, fjspath: string, isMulti: boolean, stgJschFpLst1: Array<string>) {
	let basePath;
	let fjcuri;
	
	basePath = vscode.workspace.workspaceFolders![0].uri;
	if(isMulti) {
		fjcuri = vscode.Uri.joinPath(basePath, fjspath, "fjs-config.json");
		basePath = vscode.Uri.joinPath(basePath, fjspath);
		stgJschFpLst1.push("/"+fjspath+"/"+ "fjs-config.json");
	} else {
		fjcuri = vscode.Uri.joinPath(basePath, "fjs-config.json");
		if(!fs.existsSync(fjcuri.fsPath)) {
			fjcuri = vscode.Uri.joinPath(basePath, "src", "fjs-config.json");
			if(!fs.existsSync(fjcuri.fsPath)) {
				fjcuri = vscode.Uri.joinPath(basePath, "public", "fjs-config.json");
				if(!fs.existsSync(fjcuri.fsPath)) {
					fjcuri = vscode.Uri.joinPath(basePath, "static", "fjs-config.json");
					basePath = vscode.Uri.joinPath(basePath, "static");
					stgJschFpLst1.push("/static/fjs-config.json");
					fjspath = "static";
				} else {
					basePath = vscode.Uri.joinPath(basePath, "public");
					stgJschFpLst1.push("/public/fjs-config.json");
					fjspath = "public";
				}
			} else {
				basePath = vscode.Uri.joinPath(basePath, "src");
				stgJschFpLst1.push("/src/fjs-config.json");
				fjspath = "src";
			}
		} else {
			stgJschFpLst1.push("/fjs-config.json");
			fjspath = ".";
		}
	}

	if(fs.existsSync(fjcuri.fsPath)) {
		fjs.init(basePath, fjcuri, fjspath);
	} else {
		log("[main] [ERROR]: fjs-config not found at location " + fjcuri.fsPath)
		vscode.window.showInformationMessage("Faugjs setup halted due to issues");
		throw "fjs-config.json file not found...";
	}
}

function searchWithRegex(fjs: FaugJsConfigStore, name: string, srchRegexPrefix: string, incFiles: string): vscode.Location | undefined {
	const fjcuri = vscode.Uri.joinPath(fjs.basePath!, "fjs-config.json");
	let globals = fjs.jsonFilesSymbolList[fjcuri.fsPath]["globals"];
	if(globals && globals[name]) {
		return globals[name][""]["location"];
	} else {
		vscode.commands.executeCommand("workbench.action.findInFiles", {
			query: "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')" + name,
			triggerSearch: true,
			isRegex: true,
			filesToInclude: fjs.fjspath + "/**/" + incFiles
		});
	}
	return undefined;
}

async function loadExtensions() {
	const jsonE = vscode.extensions.getExtension("vscode.json");
	await jsonE!.activate();
	//log("[main] [INFO]: json: " + jsonE!.isActive);
	const jsE = vscode.extensions.getExtension("vscode.javascript");
	await jsE!.activate();
	//log("[main] [INFO]: javascript: " + jsE!.isActive);
}

async function loadSymbolsForFile(uri: vscode.Uri, wait: boolean = false): Promise<vscode.DocumentSymbol[]> {
	//log("[main] [INFO]: Loading symbols for file => " + uri.fsPath);
	let symbols: vscode.DocumentSymbol[] | undefined = [];
	if(wait) {
		while(symbols===undefined || symbols.length==0) {
			await FaugJsConfigStore.waitFor(500);
			symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri);
		}
	} else {
		symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri);
	}
	return symbols || [];
}

function gatherSchemaAndTemplateFiles(fjs: FaugJsConfigStore, tree: Record<string, any>, stgJschFpLst: Array<string>, fjscp: string) {
	if(tree["schemas"]) {
		for (const schname in tree["schemas"]) {
			try {
				fjs.schemaList[schname] = vscode.Uri.joinPath(fjs.basePath!, tree["schemas"][schname][0]).fsPath;
				stgJschFpLst.push("/"+fjscp+"/"+tree["schemas"][schname][0]);
			} catch (error) {
				log("[main] [ERROR]: " + error.stack!);
			}
		}
	}
}

function isPossibleFuncLabel(ld: any): boolean {
	if(/^(func|outfunc|serializeFunc|serializeValueFunction|onValidateOp|beforeOp|afterDraw)$/.test(ld!.name)) {
		return true;
	} else if(/.*\.(func|outfunc|serializeFunc|serializeValueFunction|onValidateOp|beforeOp|afterDraw)$/.test(ld!.name)) {
		return true;
	}
	return false;
}

function isTemplateLabel(ld: any): boolean {
	if(/^(template|templateFile|genericTemplateFile|genericOptionTemplateFile|optionTemplateFile|__sf__|__mf__)$/.test(ld.name)) {
		return true;
	} else if(/.*\.(template|templateFile|genericTemplateFile|genericOptionTemplateFile|optionTemplateFile)$/.test(ld!.name)) {
		return true;
	}
	return false;
}

function isSchemaLabel(ld: any): boolean {
	if(/^(op|schemaName|viewerId)$/.test(ld!.name)) {
		return true;
	} else if(/.*\.(op|schemaName|viewerId)$/.test(ld!.name)) {
		return true;
	}
	return false;
}

function getWords(doc: vscode.TextDocument, position: vscode.Position): Array<any> {
	const wr = doc.getWordRangeAtPosition(position)!;
	let word1;
	let word2 = doc.getText(wr);
	if(word2.charAt(0)=="\"" && word2.charAt(word2.length-1)=="\"") {
		word2 = word2.substring(1, word2.length-1);
	}
	//log("[main] [INFO]: " + word2);
	const rg = doc.getWordRangeAtPosition(wr.start.translate(0, -1));
	if(rg) {
		word1 = doc.getText(rg);
		word1 = word1=="Fg"?"Faug":word1;
		//log("[main] [INFO]: " + word1);
	}
	return [word1, word2];
}

function handleTemFuncCrudOps(fjs: FaugJsConfigStore, doc: vscode.TextDocument, position: vscode.Position, ld: any): vscode.Location | undefined {
	if(isTemplateLabel(ld)) {
		let tmpname = ld!.detail;
		if(tmpname.startsWith("value@")) {
			tmpname = tmpname.substring(6);
		}
		const uri = vscode.Uri.joinPath(fjs.basePath!, tmpname);
		return new vscode.Location(uri, new vscode.Position(0, 0));
	} else if(isPossibleFuncLabel(ld)) {
		return fjs.findDefinition(doc, position, true);
	} else {
		if(ld!.name=="op" || ld!.name=="viewerId") {
			let cnt = position.line - 2;
			while(cnt<position.line + 2) {
				let scld = fjs.jsonFilesSymbolList[doc.uri.fsPath+"_linesinfo"][cnt++];
				if(scld && scld!.name=="schemaName") {
					let tmpname = scld!.detail;
					if(tmpname.startsWith("value@")) {
						tmpname = tmpname.substring(6);
					}
					const uripath = fjs.schemaList[tmpname];
					if(fjs.jsonFilesSymbolList[uripath]) {
						if(ld!.name=="op") {
							if(fjs.jsonFilesSymbolList[uripath]["crud"][ld!.detail]) {
								return fjs.jsonFilesSymbolList[uripath]["crud"][ld!.detail][""]["location"];
							} else {
								const uri = vscode.Uri.file(uripath);
								vscode.window.showInformationMessage("Crud operation "+ld.detail+" not found");
								return new vscode.Location(uri, new vscode.Position(0, 0));
							}
						} else {
							if(fjs.jsonFilesSymbolList[uripath]["details"] && 
							fjs.jsonFilesSymbolList[uripath]["details"]["viewer"]) {
								const viewer = fjs.jsonFilesSymbolList[uripath]["details"]["viewer"];
								for (const pos in viewer) {
									if(viewer[pos]["id"] && viewer[pos]["id"][""]["detail"]==ld!.detail) {
										return viewer[pos]["id"][""]["location"];
									}
								}
								const uri = vscode.Uri.file(uripath);
								vscode.window.showInformationMessage("Viewer "+ld.detail+" not found");
								return new vscode.Location(uri, new vscode.Position(0, 0));
							}
						}
					}
					break;
				}
			}
		} else {
			let tmpname = ld!.detail;
			if(tmpname.startsWith("value@")) {
				tmpname = tmpname.substring(6);
			}
			const uri = vscode.Uri.file(fjs.schemaList[tmpname]);
			return new vscode.Location(uri, new vscode.Position(0, 0));
		}
	}
	return undefined;
}

async function parseSchemaFiles(fjs: FaugJsConfigStore) {
	if(fjs.schemaList) {
		for (const schname in fjs.schemaList) {
			const uri = vscode.Uri.joinPath(fjs.basePath!, fjs.schemaList[schname]);
			const symbols = await loadSymbolsForFile(uri, false);
			fjs.parseJsonFile(uri, symbols);
		}
	}
}

class FaugJsConfigStore {
	private static fjsStoreMap: Record<string, FaugJsConfigStore> = {} as Record<string, FaugJsConfigStore>;
	public jsonFilesSymbolList: Record<string, any> = {} as Record<string, any>;
	public jsFilesFuncList: Record<string, any> = {} as Record<string, any>;
	public schemaList: Record<string, string> = {} as Record<string, string>;
	public moduleList: Array<string> = [] as Array<string>;
	public configList: Array<string> = [] as Array<string>;
	public templateList: Record<string, any> = {} as Record<string, any>;
	private static f_regex = /^([\t \}]*)(function)([\t ]*)([_A-Za-z0-9]+)([\t ]*\()/gm;
	public static waitFor = (delay: number) => new Promise(resolve => setTimeout(resolve, delay));
	public basePath: vscode.Uri | undefined = undefined;
	public fjcuri: vscode.Uri | undefined = undefined;
	public fjspath: string | undefined = undefined;
	public jsrefcontents: string | undefined = undefined;
	public jsrefcontentslines: number | undefined = undefined;
	public isReady = false;

	public init(basePath: vscode.Uri, fjcuri: vscode.Uri, fjspath: string) {
		this.basePath= basePath;
		this.fjcuri = fjcuri;
		this.fjspath = fjspath;
		FaugJsConfigStore.fjsStoreMap[basePath.fsPath] = this;
	}

	public isModule(uri: vscode.Uri) {
		if(uri.fsPath.endsWith("faug-min.js") || uri.fsPath.endsWith("faugn.js")) return true;
		for (const mod of this.moduleList) {
			if(uri.fsPath.endsWith(mod)) {
				return true;
			}
		}
		return false;
	}

	public isSchema(path: string) {
		for (const schname in this.schemaList) {
			if(path == this.schemaList[schname]) {
				return true;
			}
		}
		return false;
	}

	public validateTemplate(doc: vscode.TextDocument) {
		try {
			te(doc.getText(), undefined, undefined, undefined, undefined, true);
		} catch (error) {
			log("[main] [ERROR]: " + error.stack!);
		}
	}

	public getTemplate(tmplPath: string) {
		for (const tmplname in this.templateList) {
			if(tmplPath.endsWith(tmplname)) {
				return tmplname;
			}
		}
		return undefined;
	}

	public findDefinition(doc: vscode.TextDocument, position: vscode.Position, override: boolean): vscode.Location | undefined {
		if(!override && !this.isModule(doc.uri)) {
			vscode.window.showInformationMessage("Faugjs setup in progress, please try after modules (js files) are initialized..");
			return undefined;
		}
		const [word1, word2] = getWords(doc, position);
		return this.resolvePossibleFunction(doc, word1, word2, position);
	}

	public resolvePossibleFunction(doc: vscode.TextDocument, word1: string|undefined, word2: string, position: vscode.Position): vscode.Location | undefined {
		if((word1=="Faug" || word1=="Fg") && word2) {
			if(fjsdocpanel) {
				fjsdocpanel.reveal();
				fjsdocpanel.webview.postMessage({ func: word2 });
			} else {
				fjspanelword = word2;
				vscode.commands.executeCommand('faugjs.docs');
			}
			return;
		}
		
		for(const filename in this.jsFilesFuncList) {
			if(!doc.uri.fsPath.endsWith(filename)) {
				if(word1 && this.jsFilesFuncList[filename][word1] && this.jsFilesFuncList[filename][word1][word2]) {
					return this.jsFilesFuncList[filename][word1][word2][""]["location"];
				} else if(word2 && this.jsFilesFuncList[filename][word2]) {
					return this.jsFilesFuncList[filename][word2][""]["location"];
				}
			}
		}

		/**
		 * Jump to route definition/global var declaration etc etc if the text clicked is a Fg function
		 */
		const line = doc.lineAt(position);
		const match = /(Fg|Faug)[\t ]*\.[\t ]*(routeTo|r|getGlobalVar|g|invokeCrudOp|ic|drawCreateForm|dcf|templatize|templatizeByName)[\t ]*\([\t ]*('|")(.+)('|")(.*)/.exec(line.text);
		if(match && match.length==7) {
			let arg = match[4].trim();
			if(match[2]=="routeTo" || match[2]=="r") {
				return getRouteLocation(this, undefined, arg);
			} else if(match[2]=="getGlobalVar" || match[2]=="g") {
				return searchWithRegex(this, arg, "(Faug|Fg)\\.(g|getGlobalVar)\\((\"|')", "*.js");
			} else if(match[2]=="invokeCrudOp" || match[2]=="ic" || match[2]=="drawCreateForm" || match[2]=="dcf") {
				if(arg.indexOf(match[3])!=-1) {
					arg = arg.substring(0, arg.indexOf(match[3]));
				}
				const uri = vscode.Uri.file(this.schemaList[arg]);
				return new vscode.Location(uri, new vscode.Position(0, 0));
			} else if(match[2].startsWith("templatize")) {
				const uri = vscode.Uri.joinPath(this.basePath!, arg);
				return new vscode.Location(uri, new vscode.Position(0, 0));
			}
		}

		return undefined;
	}

	private static lineNumberByIndex(index: number, str: string) {
		const re = /^[\S\s]/gm;
		let line = 0,
			match;
		let lastRowIndex = 0;
		while ((match = re.exec(str))) {
			if (match.index > index) break;
			lastRowIndex = match.index;
			line++;
		}
		return [Math.max(line - 1, 0), lastRowIndex];
	}

	private static findOccurrences = (needle: RegExp, haystack: string) => {
		let match;
		const result = [];
		while ((match = needle.exec(haystack))) {
			const pos = FaugJsConfigStore.lineNumberByIndex(needle.lastIndex, haystack);
			result.push({
				match: match[4],
				lineNumber: pos[0],
				column: needle.lastIndex - pos[1] - match[0].length + match[1].length
			});
		}
		return result;
	};

	private resolveClass(symbol: vscode.DocumentSymbol, lst: Record<string, any>) {
		if(symbol.kind === vscode.SymbolKind.Class) {
			lst[symbol.name] = {"": symbol};
			for(const child of symbol.children) {
				if(child.kind === vscode.SymbolKind.Constructor) {
					lst[symbol.name][child.name] = {"": child};
				} else if(child.kind === vscode.SymbolKind.Method) {
					lst[symbol.name][child.name] = {"": child};
				} else if(child.kind === vscode.SymbolKind.Property) {
					lst[symbol.name][child.name] = {"": child};
				}
			}
		}
	}

	private resolveNewFunction(symbol: vscode.DocumentSymbol, lst: Record<string, any>) {
		for(const child of symbol.children) {
			if(child.kind === vscode.SymbolKind.Function) {
				this.resolveFunction(child, lst);
			} else if(child.kind === vscode.SymbolKind.Variable) {
				lst[child.name] = {"": child};
			} else if(child.kind === vscode.SymbolKind.Property) {
				lst[child.name] = {"": child};
			} else if(child.kind === vscode.SymbolKind.Method) {
				lst[child.name] = {"": child};
			}
		}
	}

	private resolveFunction(symbol: vscode.DocumentSymbol, lst: Record<string, any>) {
		lst[symbol.name] = {"": symbol};
		for(const child of symbol.children) {
			if(child.kind === vscode.SymbolKind.Function) {
				lst[symbol.name][child.name] = {"": child};
			}
		}
	}

	private resolveVar(symbol: vscode.DocumentSymbol, lst: Record<string, any>) {
		if(symbol.kind === vscode.SymbolKind.Variable || symbol.kind === vscode.SymbolKind.Constant) {
			lst[symbol.name] = {"": symbol};
			for(const child of symbol.children) {
				if(child.kind === vscode.SymbolKind.Function && child.name === "<function>") {
					this.resolveNewFunction(child, lst[symbol.name]);
				} else if(child.kind === vscode.SymbolKind.Function) {
					this.resolveFunction(child, lst[symbol.name]);
				} else if(child.kind === vscode.SymbolKind.Property) {
					lst[symbol.name][child.name] = {"": child};
				}
			}
		}
	}

	private resolveJsonPath(symbol: vscode.DocumentSymbol, lst: Record<string, any>, lstli: Array<any>) {
		lst[symbol.name] = {"": symbol};
		lstli[symbol.range.start.line] = symbol;
		for(const child of symbol.children) {
			this.resolveJsonPath(child, lst[symbol.name], lstli);
		}
	}

	public parseJsonFile(uri: vscode.Uri, symbols: vscode.DocumentSymbol[]) {
		if(symbols.length>0) {
			this.jsonFilesSymbolList[uri.fsPath] = {};
			this.jsonFilesSymbolList[uri.fsPath+"_linesinfo"] = {};
		}
		for(const symbol of symbols!) {
			this.resolveJsonPath(symbol, this.jsonFilesSymbolList[uri.fsPath], 
				this.jsonFilesSymbolList[uri.fsPath+"_linesinfo"]);
		}
	}

	public parseJsFile(uri: vscode.Uri, symbols: vscode.DocumentSymbol[] | undefined) {
		if(symbols!.length>0) this.jsFilesFuncList[uri.fsPath] = {};
		//log("[main] [INFO]: Parsing js module file => " + uri.fsPath);
		for(const symbol of symbols!) {
			try {
				if(symbol.name == "<unknown>") {
					continue;
				}
				if(symbol.kind === vscode.SymbolKind.Variable || symbol.kind === vscode.SymbolKind.Constant) {
					this.resolveVar(symbol, this.jsFilesFuncList[uri.fsPath]);
				} else if(symbol.kind === vscode.SymbolKind.Function) {
					if(symbol.name.endsWith(") callback")) continue;
					this.resolveFunction(symbol, this.jsFilesFuncList[uri.fsPath]);
				} else if(symbol.kind === vscode.SymbolKind.Class) {
					this.resolveClass(symbol, this.jsFilesFuncList[uri.fsPath]);
				}
			} catch (error) {
				log("[main] [ERROR]: " + error.stack!);
			}
		}
	}

	public static getFaugJsConfigStore(doc: vscode.TextDocument): FaugJsConfigStore | undefined {
		const tmp = [];
		for(const path in FaugJsConfigStore.fjsStoreMap) {
			if(doc.uri.fsPath.startsWith(path)) {
				tmp.push(path);
			}
		}
		if(tmp.length>0) {
			tmp.sort(function(a, b) {
				return a.length - b.length;
			});
			return FaugJsConfigStore.fjsStoreMap[tmp[tmp.length-1]];
		}
		return undefined;
	}
}

/**
 * Start non strict typescript code
 */
 function jsonParse(json: string, err2print: string, numerrs: any[]) {
    try {
        return JSON.parse(json);
    } catch (e) {
		try {
            parseJson(json);
        } catch (e) {
            log("[main] [INFO]: " + err2print);
            log("[main] [ERROR]: " + e.stack!);
            numerrs[0] = numerrs[0] + 1;
        }
    }
}

function getEssentials(dirPath: any, module: any) {
    let rawHtml = fs.readFileSync(dirPath + path.sep + 'index.html', 'utf8');
    
    let numerrs = [0];
    let configFileName = 'fjs-config.json';
    log("[main] [INFO]: module name ---->" + module);
    if(module != "") {
    	configFileName = 'fjs-config_'+module+'.json';
    }
    let config = jsonParse(fs.readFileSync(dirPath + path.sep + configFileName, 'utf8'), "Error parsing fjs-config.json, invalid json", numerrs);
    if(numerrs[0]>0) {
        throw "Unable to read fjs-config.json"
    }
    return [rawHtml, config];
}

function compressSchemas(config: any, fileName: any, type: any, dirPath: any, sc: any) {
    let schemas: Record<string, any> = {};
    let numerrs = [0];
	let context, data;
    if((type==1 || type==3) && fileName) {
        context = "XXXXX Error parsing schema schemas/" + fileName;
        data = jsonParse(fs.readFileSync(dirPath + path.sep + "schemas" + path.sep + fileName, 'utf8'), context, numerrs);
        schemas["schemas/" + fileName] = data;
        sc[0] = sc[0] + 1;
    } else if (is('Array', config.schemas)) {
        for (let i = 0; i < config.schemas.length; i++) {
            context = "XXXXX Error parsing schema " + config.schemas[i][0];
            data = jsonParse(fs.readFileSync(dirPath + path.sep + config.schemas[i][0], 'utf8'), context, numerrs);
            schemas[config.schemas[i][0]] = data;
            sc[0] = sc[0] + 1;
        }
    } else {
        for ( let k in config.schemas) {
            if (config.schemas.hasOwnProperty(k)) {
                context = "XXXXX Error parsing schema " + config.schemas[k][0];
                data = jsonParse(fs.readFileSync(dirPath + path.sep + config.schemas[k][0], 'utf8'), context, numerrs);
                schemas[config.schemas[k][0]] = data;
                sc[0] = sc[0] + 1;
            }
        }
    }
    
    if(type==2) {
        sc[0] = 0;
    }

    if (numerrs[0] > 0) {
        throw "Error while reading schema files"
    }
    
    return schemas;
}

let currtemcode: string, temerror = 0;
function formatTemplate(fjstemplatedgcoll: vscode.DiagnosticCollection, mode: number) {
	const doc = vscode.window.activeTextEditor!.document;
	let data = fs.readFileSync(doc.uri.fsPath, 'utf8');
	let lines = data.split('\n');
	const tlen = lines.length;
	data = '';
	let ln = 1;
	for(const l of lines) {
		data += l + ' <!--___'+(ln++)+'___-->\n'
	}
	//console.log(data);

	const opts = {"preserve-newlines": true};
	let jssc = '';
	let tmp = XRegExp.match(data, XRegExp('^([\\t ]*)##([\\s\\S\\n]*?)##.*', 'gm'), 'all', opts);
	for(const t of tmp) {
		for(let l of t.split("\n")) {
			if(l.trim().startsWith("##")) jssc += l.replace('##', '') + '\n';
			else if(l.indexOf("##")!=-1) {
				jssc += XRegExp.replace(l, XRegExp('## <!--___(\\d+)___-->', 'g'), '<!--___$1___-->', 'all', opts) + '\n';
			} else jssc += l + '\n';
		}
	}
	data = XRegExp.replace(data, XRegExp('^([\\t ]*)##([\\s\\S\\n]*?)##.*', 'gm'), '', 'all');
	tmp = XRegExp.match(data, XRegExp('^([\\t ]*)#(.*)', 'gm'), 'all', opts);
	data = XRegExp.replace(data, XRegExp('^([\\t ]*)#(.*)', 'gm'), '', 'all');
	for(let l of tmp) {
		l = l.replace('#', '');
		jssc += l + '\n';
	}
	tmp = XRegExp.match(data, XRegExp('^([\\t ]*)!!(.*)!!.*', 'gm'), 'all', opts);
	data = XRegExp.replace(data, XRegExp('^([\\t ]*)!!(.*)!!.*', 'gm'), '', 'all');
	for(const l of tmp) {
		jssc += l.substring(0, l.indexOf('!!')) + '//' + l.substring(l.indexOf('!!')) + '\n';
	}
	let jscc1 = XRegExp.replace(jssc, XRegExp('<!--___(\\d+)___-->', 'g'), '//$1', 'all', opts);
	jscc1 = jscc1.split("\n").sort(function(a,b) {
		const ad = a.substring(a.lastIndexOf("//")+2);
		const bd = b.substring(b.lastIndexOf("//")+2);
		return ad-bd;
	}).join("\n");
	
	//console.log(js_beautify(jscc1));
	jscc1 = jsb.js_beautify(jscc1).split("\n");
	let jscc2 = [];
	let jl = '';
	for(const l of jscc1) {
		if(!/\/\/\d+$/.test(l)) {
			jl += l + ' ';
		} else {
			if(jl!='') {
				jscc2.push(jl+l.trimLeft());
			} else {
				jscc2.push(l);
			}
			jl = '';
		}
	}
	if(jl!='') {
		jscc2.push(jl);
	}
	var jsmap = jscc2.reduce(function(map, line) {
		const ln = line.substring(line.lastIndexOf("//")+2);
		map[ln*1] = line.substring(0, line.lastIndexOf("//"));
		if(line.trim()=="") {
			map[ln*1] = "";
		} else {
			const spacesAtStart = map[ln*1].length - map[ln*1].trimLeft().length;
			if(map[ln*1].indexOf("//!!")!=-1) {
				map[ln*1] = map[ln*1].replace('//!!', '!!');
			} else {
				map[ln*1] = map[ln*1].substring(0, spacesAtStart) + (mode!=3?'#':'') + map[ln*1].substring(spacesAtStart);
			}
		}
		return map;
	}, {});

	data = XRegExp.replace(data, XRegExp('<%(.*?)%>', 'g'), '__%%__$1__%%__', 'all');
	data = jsb.html_beautify(data).split("\n");
	let htmdata = [];
	jl = '';
	for(const l of data) {
		if(!/<!--___\d+___-->$/.test(l)) {
			jl += l + ' ';
		} else {
			if(jl!='') {
				htmdata.push(jl+l.trimLeft());
			} else {
				htmdata.push(l);
			}
			jl = '';
		}
	}
	if(jl!='') {
		htmdata.push(jl);
	}
	//console.log(htmdata.join('\n'));
	var htmap = htmdata.reduce(function(map, line) {
		const ln = line.substring(line.lastIndexOf("<!--___")+7).replace('___-->', '');
		map[ln*1] = line.substring(0, line.lastIndexOf("<!--___"));
		return map;
	}, {});
	//console.log(data);

	let fdata = '';
	let lastind = '', don = false;
	for(let i=1;i<=tlen;i++) {
		if(mode<=2 && htmap[i]) {
			if(!don) lastind = XRegExp.match(htmap[i], XRegExp('^([\\t ]*)'));
			fdata += htmap[i] + '\n';
		} else if((mode==1 || mode==3) && jsmap[i]) {
			if(lastind && !don) don = true;
			fdata += jsmap[i] + '\n';
		} else fdata += '\n';
	}
	if(mode<=2) fdata = XRegExp.replace(fdata, XRegExp('__%%__(.*?)__%%__', 'g'), '<%$1%>', 'all');
	let tname = doc.uri.fsPath.substring(doc.uri.fsPath.lastIndexOf(path.sep)+1);
	if(mode==2) {
		saveAndOpenNewTmpFile(tname, fdata);
	} else if(mode==3) {
		tname += ".js"
		saveAndOpenNewTmpFile(tname, fdata);
	} else {
		fs.writeFileSync(doc.uri.fsPath, fdata, 'utf8');
	}
}
function faugX(dirPath: any, htmlTemplates: any, tname: any, options: any, flag: any, istmfromopts: any, isValidate: any) {
	flag = isN(flag) ? false : flag;
	let data = fs.readFileSync(dirPath + path.sep + tname, 'utf8');
	if (flag) {
		htmlTemplates[tname] = [data];
	} else {
		try {
			let fb = te(data, options, true, istmfromopts, true, true);
			if (is('String', fb)) {
				temerror = -1;
				if(isValidate) {
					return [-1, "XXXXX Error compiling template " + tname, undefined, currtemcode];
				}
				log("[main] [ERROR]: XXXXX Error compiling template " + tname);
				log("[main] [ERROR]: " + fb);
			} else {
				fb = fb.toString();
				fb = fb.slice(fb.indexOf("{") + 1, fb.lastIndexOf("}"));
				htmlTemplates[tname] = fb;
				if(isValidate) {
					return [0, undefined, undefined, currtemcode];
				}
			}
		} catch (err) {
			temerror = -1;
			if(isValidate) {
				return [-1, "XXXXX Error compiling template " + tname, err, currtemcode];
			}
			log("[main] [ERROR]: XXXXX Exception compiling template " + tname);
			log("[main] [ERROR]: " + err.stack!);
			log("[main] [ERROR]: " + currtemcode);
		}
	}
}

function te(html: any, options: any, retFunc: any, isVarFromOptions: any, escH: any, isdebug: boolean) {
	if(isdebug) {
		const htmlparts = html.split("\n");
		for(let i=0;i<htmlparts.length;i++) {
			if(htmlparts[i].trim().startsWith("##")) {
				htmlparts[i] = "##/*" + (i+1) + "*/" + htmlparts[i].trim().substring(2);
			} else if(htmlparts[i].trim().startsWith("#")) {
				htmlparts[i] = "#/*" + (i+1) + "*/" + htmlparts[i].trim().substring(1);
			} else if(htmlparts[i].trim().startsWith("!!")) {
				htmlparts[i] = "!!/*" + (i+1) + "*/" + htmlparts[i].trim().substring(2);
			} else {
				htmlparts[i] = "/*"+(i+1)+"*/" + htmlparts[i];
			}
		}
		html = htmlparts.join("\n");
	}
	escH = escH === false ? false : true;
	if (!html) {
		if (retFunc) {
			return Function.apply(null, ["arg", "return '';"]);
		} else {
			return Function.apply(null, ["arg", "return '';"]).apply(null, [options]);
		}
	}

	isVarFromOptions = (!isVarFromOptions) ? false : true;
	var re = /<%(.*?)%>/g, reExp = /^#(.*)/g, reExpr = /^#(.*)/g, code = '', cursor = 0, match;
	const mulre = /##([\s\S]*?)##/g;
	let incre = /!!([a-zA-Z0-9_\-\.\s\/()]+)!!/g;
	const varnamere = /^[^a-zA-Z_$]|[^\\w$]/;
	if(isdebug) {
		incre = /!!(\/\*[0-9]+\*\/[\t ]*[a-zA-Z0-9_\-\.\s\/()]+)!!/g;
	}

	var nhtml = '';
	while (match = mulre.exec(html)) {
		nhtml += html.slice(cursor, match.index);
		let htmlines = match[1].split("\n");
		for (var i = 0; i < htmlines.length; i++) {
			if (htmlines[i].trim() != "") {
				nhtml += "#" + htmlines[i] + "\n";
			} else {
				nhtml += "<!-- debug -->\n";
			}
		}
		cursor = match.index + match[0].length;
	}
	nhtml += html.substr(cursor, html.length - cursor);
	cursor = 0;
	html = nhtml;

	var add = function(line: any, js: any) {
		if (line != "") {
			var isvar = line.trim().match(reExpr);
			var tl = line;
			if (!isvar) {
				var escnot = false;
				if (line.trim()[0] == '!') {
					tl = line.substring(line.indexOf("!") + 1);
					escnot = true;
				}
				var dotnt = tl.split(".");
				var dospl = true;
				if(js && tl.indexOf("(")!=-1 && tl.indexOf(")")!=-1) {
					var y = tl.replace(/"(.*)"/g, "");
					if(y.indexOf("(")!=-1 && y.indexOf(")")!=-1) {
						dospl = false;
					}
				}
				var isjsvarflag = true;
				var jsvartl = "";
				for (var k = 0; k < dotnt.length; k++) {
					if(!dospl) {
						jsvartl = tl;
						isjsvarflag = true;
						escnot = true;
						break;
					} else if (k == 0 && js && isVarFromOptions && varnamere.test(dotnt[k])/* && options.hasOwnProperty(dotnt[k])*/) {
						isjsvarflag = isjsvarflag && true;
						jsvartl = 'arg["' + dotnt[0] + '"]';
					} else if (js && isVarFromOptions && varnamere.test(dotnt[k])) {
						isjsvarflag = isjsvarflag && true;
						jsvartl += "." + dotnt[k];
					} else {
						isjsvarflag = isjsvarflag && false;
					}
				}

				if (isjsvarflag && escnot) {
					line = line.substring(line.indexOf("!") + 1);
				}

				if (incre.test(line)) {
					code += line + '\n';
				} else if (isjsvarflag) {
					line = jsvartl;
					if (escH) {
						if (escnot) {
							code += isvar ? (line + '\n') : ('____r_____.push(' + line + ');\n');
						} else {
							code += isvar ? (line + '\n') : ('____r_____.push(Fg.eh(' + line + '));\n');
						}
					} else {
						code += isvar ? (line + '\n') : ('____r_____.push(' + line + ');\n');
					}
				} else {
					let pgi = "";
					if(isdebug && tl.startsWith("/*")) {
						pgi = tl.substring(0, tl.indexOf("*/")+2);
						tl = tl.substring(tl.indexOf("*/")+2);
					}
					line = js ? tl : ('"' + tl.replace(/"/g, '\\"') + '"');
					code += isvar ? (line + '\n') : ('____r_____.push(' + pgi + line + ');\n');
				}
			} else if (incre.test(line)) {
				code += line + '\n';
			} else {
				code += isvar ? (line + '\n') : ('____r_____.push(' + line + ');\n');
			}
			incre.lastIndex = 0;
		}
		return add;
	};
	var htmlines = html.split("\n");
	for (var i = 0; i < htmlines.length; i++) {
		cursor = 0;
		var htm = htmlines[i];
		var f = false;
        if(htm.trim()=="") {
            code += "<!-- debug -->\n";
            continue;
        }
		while (match = re.exec(htm)) {
			f = true;
			add(htm.slice(cursor, match.index), undefined)(match[1], true);
			cursor = match.index + match[0].length;
		}
		add(htm.substr(cursor, htm.length - cursor), undefined);
	}

	var addf = function(line: any, js: any) {
		if (line != '') {
			if (js || incre.test(line)) {
				code += line + '\n';
			} else {
				if (line.indexOf('____r_____.push(') == 0) {
					code += line + "\n";
				} else {
					let pgi = "";
					if(isdebug && line.startsWith("/*")) {
						pgi = line.substring(0, line.indexOf("*/")+2);
						line = line.substring(line.indexOf("*/")+2);
					}
					code += '____r_____.push( '+pgi+' "' + line.replace(/"/g, '\\"') + '");\n';
				}
			}
			incre.lastIndex = 0;
		}
		return addf;
	};
	var ncode = code, code = '';
	htmlines = ncode.split("\n");
	for (var i = 0; i < htmlines.length; i++) {
		cursor = 0;
		var htm = htmlines[i].trim();
		var f = false;
		while (match = reExp.exec(htm)) {
			f = true;
			addf(htm.slice(cursor, match.index), false)(match[1], true);
			cursor = match.index + match[0].length;
		}
		addf(htm.substr(cursor, htm.length - cursor), false);
	}
	var fcode = 'var ____r_____=[];\n';
	if (!isVarFromOptions) {
		for ( var k in options) {
			if (options.hasOwnProperty(k)) {
				fcode += 'var ' + k + '=' + 'arg["' + k + '"];\n';
			}
		}
	}

	var addI = function(line: any, ismatch: any) {
		if (line != "") {
			if (ismatch) {
				line = line.trim();
				var cmps = line.substring(line.lastIndexOf(".html")+5).trim().split(" ");
				code += "var _exttargs = {};\n";
				line = line.substring(0, line.lastIndexOf(".html")+5);
				for (var i = 1; i < cmps.length; i++) {
					var t = cmps[i].trim();
					if (t.indexOf("(") == 0 && t.indexOf(")") == t.length - 1) {
						t = t.substr(1, t.length - 2);
					}
					t = t.trim();
					if (t != "") {
						code += 'if(typeof(' + t + ') !== "undefined")_exttargs["' + t + '"] = ' + t + ';\n';
					}
				}
				let pgi = "";
				if(isdebug && line.startsWith("/*")) {
					pgi = line.substring(0, line.indexOf("*/")+2);
					line = line.substring(line.indexOf("*/")+2);
				}
				code += ('____r_____.push('+pgi+'Faug.includeTemplate(\"' + line.trim() + '\", _exttargs));\n');
			} else {
				code += line + '\n';
			}
		}
		return addI;
	};
	var ncode = code, code = '';
	htmlines = ncode.split("\n");
	for (var i = 0; i < htmlines.length; i++) {
		cursor = 0;
		var htm = htmlines[i];
		var f = false;
		while (match = incre.exec(htm)) {
			f = true;
			addI(htm.slice(cursor, match.index), undefined)(match[1], true);
			cursor = match.index + match[0].length;
		}
		addI(htm.substr(cursor, htm.length - cursor), undefined);
	}

	code = fcode + code + 'return ____r_____.join("");\n';
	//code = code.replace(/[\r\n]/g, '');
	currtemcode = code;
	if (retFunc) {
		return Function.apply(null, ["arg", code]);
	} else {
		return Function.apply(null, ["arg", code]).apply(null, [options]);
	}
}

function compressTemplates(config: any, fileName: any, type: any, schemas: any, dirPath: any, tc: any, lazyValidation: any, htmlTemplates: any) {
    let templates = [];
    if(type==1) {
    	return htmlTemplates;
    } else if (config["templates"] && is('Array', config.templates) && config.templates.length > 0) {
    	
        for (let i = 0; i < config.templates.length; i++) {
            let tmplnm = config.templates[i];
            if (tmplnm.indexOf("tiuxmls/") >= 0) {
            	continue;
            }
            let tmplvars = {rows: null, options: null, row: null};
            let cstvars = 0;
            if (is('Array', config.templates[i])) {
                tmplnm = config.templates[i][0];
                tmplvars = config.templates[i][1];
                cstvars = config.templates[i].length == 3 ? config.templates[i][2] : 0;
                if(config.templates[i].length==2 && config.templates[i][1]) {
                    cstvars = 5;
                }
            }
            if (!tmplvars) {
                if(!fileName || 'templates/'+fileName==tmplnm) {
                    templates.push([tmplnm, cstvars]);
                }
            } else {
                if(!fileName || 'templates/'+fileName==tmplnm) {
                    templates.push([tmplnm, cstvars, tmplvars]);
                }
            }
        }
    }
    
    for ( let sk in schemas) {
        if (!schemas.hasOwnProperty(sk)) continue;
        let data = schemas[sk];

        if (data["templateFile"]) {
            if(!fileName || 'templates/'+fileName==data["templateFile"]) {
                templates.push([data["templateFile"], 4]);
            }
        }

        addNestedTemplates(data, data, templates, fileName);
        if(data["details"] && data["details"]["viewer"]) {
            for(let v=0;v<data["details"]["viewer"].length;v++) {
                let va = data["details"]["viewer"][v];
                if(va && va["helperArea"] && va["helperArea"]["schema"]) {
                    va = va["helperArea"]["schema"];
                    addNestedTemplates(va, va, templates, fileName);
                }
            }
        }

        for ( let o in data.crud) {
            if (data.crud.hasOwnProperty(o)) {
                if (data.crud[o]["template"]) {
                    if (is('Object', data.crud[o]["template"]) && data.crud[o]["template"]["vars"] && data.crud[o]["template"]["values"] && data.crud[o]["template"]["vars"].length > 0 && data.crud[o]["template"]["values"].length > 0) {
                        let ttf = data.crud[o]["template"];
                        let cvars = ttf["vars"];
                        for (let ii = 0; ii < ttf["values"].length; ii++) {
                            let cvals = ttf["values"][ii][0];
                            let flag = cvals.length == cvars.length;
                            if (flag) {
                                if(!fileName || 'templates/'+fileName==ttf["values"][ii][1]) {
                                    templates.push([ttf["values"][ii][1], 0]);
                                }
                            }
                        }
                    } else {
                        if(!fileName || 'templates/'+fileName==data.crud[o]["template"]) {
                            templates.push([data.crud[o]["template"], 0]);
                        }
                    }
                }
            }
        }
    }
    
    let uniqtmpl: Record<string, any> = {};
    for (let i = 0; i < templates.length; i++) {
        let type = templates[i][1];
        let tname = templates[i][0];
        let tmplvars = templates[i].length == 3 ? templates[i][2] : null;
        if (type == 0) {
            if (!uniqtmpl[tname]) {
                if(!lazyValidation) {
					faugX(dirPath, htmlTemplates, tname, {rows: null, options: null}, undefined, undefined, undefined);
                	uniqtmpl[tname] = 0;
				} else {
					htmlTemplates[tname] = [0];
				}
                tc[0] = tc[0] + 1;
            }
        } else if (type == 1 || type == 2) {
            if (!uniqtmpl[tname]) {
                if(!lazyValidation) {
					faugX(dirPath, htmlTemplates, tname, {isTransient: null, elName: null, rows: null, selectedVal: null, details: null, vars: null, options: null}, undefined, undefined, undefined);
                	uniqtmpl[tname] = 2;
				} else {
					htmlTemplates[tname] = [2];
				}
                tc[0] = tc[0] + 1;
            }
        } else if (type == 3 || type == 5) {
            if (!uniqtmpl[tname]) {
                if(!lazyValidation) {
					faugX(dirPath, htmlTemplates, tname, tmplvars, undefined, undefined, undefined);
                	uniqtmpl[tname] = 5;
				} else {
					htmlTemplates[tname] = [5, tmplvars];
				}
                tc[0] = tc[0] + 1;
            }
        } else if (type == 4) {
            if (!uniqtmpl[tname]) {
                if(!lazyValidation) {
					faugX(dirPath, htmlTemplates, tname, tmplvars, false, true, undefined);
                	uniqtmpl[tname] = 4;
				} else {
					htmlTemplates[tname] = [4, tmplvars];
				}
                tc[0] = tc[0] + 1;
            }
        }
        if(temerror == -1) {
            //throw "Error while reading templates";
        }
    }
}

function isN(val: any) {
    return val === undefined || val == null || val === '';
}

function is(type: any, obj: any) {
    let clas = Object.prototype.toString.call(obj).slice(8, -1);
    return obj !== undefined && obj !== null && clas === type;
}

function addNestedTemplates(schema: any, data: any, templates: any, fileName: any) {
    let properties;
    if(data.type==="object") {
        properties = data["properties"];
    } else if(data.type=="array" && data.items) {
        properties = data.items["properties"]; 
    }

    if(properties) {
        for(let p in properties) {
            if(properties[p]["type"]=="object" || properties[p]["type"]=="array") {
                addNestedTemplates(schema, properties[p], templates, fileName);
                continue;
            }
            if (properties.hasOwnProperty(p) && !isN(properties[p]["optionTemplateFile"])) {
                if(!fileName || 'templates/'+fileName==properties[p]["optionTemplateFile"]) {
                    templates.push([properties[p]["optionTemplateFile"], 1]);
                }
            } else if (properties.hasOwnProperty(p) && !isN(properties[p]["genericOptionTemplateFile"])) {
                if(!fileName || 'templates/'+fileName==properties[p]["genericOptionTemplateFile"]) {
                    templates.push([properties[p]["genericOptionTemplateFile"], 2]);
                }
            } else if (properties.hasOwnProperty(p) && !isN(properties[p]["templateFile"])) {
                if(!fileName || 'templates/'+fileName==properties[p]["templateFile"]) {
                    templates.push([properties[p]["templateFile"], 1]);
                }
            } else if (properties.hasOwnProperty(p) && !isN(properties[p]["genericTemplateFile"])) {
                if(!fileName || 'templates/'+fileName==properties[p]["genericTemplateFile"]) {
                    templates.push([properties[p]["genericTemplateFile"], 2]);
                }
            }

            if(schema["namedEvents"] && is('Object', schema.namedEvents) && properties.hasOwnProperty(p) && properties[p]["events"]) {
                for(let e in properties[p]["events"]) {
                    if(properties[p]["events"].hasOwnProperty(e)) {
                        if(is('String', properties[p]["events"][e]) && schema.namedEvents[properties[p]["events"][e]]) {
                            properties[p]["events"][e] = schema.namedEvents[properties[p]["events"][e]];
                        } else if(is('Array', properties[p]["events"][e])) {
                            for(let t=0;t<properties[p]["events"][e].length;t++) {
                                if(is('String', properties[p]["events"][e][t]) && schema.namedEvents[properties[p]["events"][e][t]]) {
                                    properties[p]["events"][e][t] = schema.namedEvents[properties[p]["events"][e][t]];
                                } 
                            }
                        }
                    }
                }
            }
        }
    }
}

function compressJsCss(rawHtml: any, config: any, dirPath: string, schemas: any, htmlTemplates: any, module: any) {
	let doc = new dom({
		errorHandler: { 
			warning: function (w) {}, 
			error: function (e) {
				log("[main] [ERROR]: " + e.stack);
				throw e; 
			}, 
			fatalError: function (e) { 
				log("[main] [ERROR]: " + e.stack);
				throw e; 
			} 
		}
	}).parseFromString(rawHtml);
    function getNodes(xp: any) {
        return xpath.select(xp, doc);
    }
    let cssFiles = [];
	cssFiles.push([] as string[]);
	cssFiles.push([] as string[]);
    let jsFileObjArr = [];
    let tags = <any> getNodes("/html/head/link");
    for (let t = 0; t < tags.length; t++) {
        for (let i = 0; i < tags[t].attributes.length; i++) {
            if(tags[t].attributes[i].name.toLowerCase()=="href" && tags[t].attributes[i].value) {
                let href = <string> tags[t].attributes[i].value;
                if(href.indexOf("ext.css")!=-1)continue;
                if (href.endsWith("min.css")) {
                    cssFiles[0].push(dirPath + path.sep + href);
                } else if (href.endsWith(".css")) {
                    cssFiles[1].push(dirPath + path.sep + href);
                }
            }
        }
    }
    tags = getNodes("/html/head/script");
    for (let t = 0; t < tags.length; t++) {
        let href;
        for (let i = 0; i < tags[t].attributes.length; i++) {
            if(tags[t].attributes[i].name.toLowerCase()=="src" && tags[t].attributes[i].value) {
                let href = tags[t].attributes[i].value;
                if(href.indexOf("cordova.js")!=-1)continue;
                if(href.indexOf("resources/external_api.js")!=-1)continue;
                if(href.indexOf("resources/peerjs.min.js")!=-1)continue;
                if(href.indexOf("ext.js")!=-1)continue;
                var jsFileObj: Record<string, any> = {};
                var isMin = false;
                jsFileObj["name"] = dirPath + path.sep + href;
                if (href.endsWith("min.js")) {
                	isMin = true;
                } else {
					jsFileObj["mname"] = dirPath + path.sep + "out" + path.sep + href;
				}
                jsFileObj["isMin"] = isMin;
                jsFileObjArr.push(jsFileObj);
            }
        }
    }
    
    function validateJsFiles(jsFileObjArr:any, cssFiles:any, config:any, dirPath:any) {
    	var jsFileObj: Record<string, any> = {} as Record<string, any>;
    	jsFileObj["name"] = dirPath + path.sep + "resources/bootstrap.min.js";
    	jsFileObj["isMin"] = true;
    	jsFileObjArr.splice(1, 0, jsFileObj);
    	
    	var jsFileObj: Record<string, any> = {} as Record<string, any>;
    	jsFileObj["name"] = dirPath + path.sep + "resources/bootbox.min.js";
    	jsFileObj["isMin"] = true;
    	jsFileObjArr.push(jsFileObj);
    	
        let deps = [["resources/javascript-xpath-latest-cmp.js"], ["resources/json2.js"], ["resources/jquery.dataTables.js"], ["resources/dataTables.bootstrap.js"],["faug-ext-globalize.js"]];
        for (let i = 0; i < deps.length; i++) {
        	var jsFileObj: Record<string, any> = {} as Record<string, any>;
        	jsFileObj["name"] = dirPath + path.sep + deps[i][0];
			jsFileObj["mname"] = dirPath + path.sep + "out" + path.sep + deps[i][0];
        	jsFileObj["isMin"] = false;
        	jsFileObjArr.push(jsFileObj);
        }
        let deps1 = ["resources/cldr/cldr.js", "resources/cldr/event.js", "resources/cldr/supplemental.js", "resources/globalize/globalize.js", "resources/globalize/number.js", "resources/globalize/plural.js", "resources/globalize/currency.js", "resources/globalize/date.js", "resources/globalize/message.js", "resources/globalize/relative-time.js", "resources/globalize/unit.js", "resources/jquery.datetimepicker.js", "resources/diffDOM.js"];
        for (let i = 0; i < deps1.length; i++) {
            var jsFileObj: Record<string, any> = {} as Record<string, any>;
        	jsFileObj["name"] = dirPath + path.sep + deps1[i];
			jsFileObj["mname"] = dirPath + path.sep + "out" + path.sep + deps1[i];
        	jsFileObj["isMin"] = false;
        	jsFileObjArr.push(jsFileObj);
        }
        for (let i = 0; i < config.modules.length; i++) {
        	var jsFileObj: Record<string, any> = {} as Record<string, any>;
        	var isMin = false;
        	jsFileObj["name"] = dirPath + path.sep + config.modules[i];
            if (config.modules[i].endsWith("min.js")) {
            	isMin = true;
            }  else {
				jsFileObj["mname"] = dirPath + path.sep + "out" + path.sep + config.modules[i];
			}
            jsFileObj["isMin"] = isMin;
            jsFileObjArr.push(jsFileObj);
        }

        let jsfilesAll = [];
        
        for(let i = 0; i < jsFileObjArr.length; i++) {
        	jsfilesAll.push(jsFileObjArr[i]["name"]);
        }

        //log("[main] [INFO]: " + JSON.stringify(jsfilesAll));
        //log("[main] [INFO]: " + JSON.stringify(jsFiles));

        log("[main] [INFO]: Total number of js files = " + jsFileObjArr.length);
        log("[main] [INFO]: Total number of css files = " + (cssFiles[0].length + cssFiles[1].length));

        let flag = 0;
        let allcssfiles = [].concat(cssFiles[0]).concat(cssFiles[1]);
        for (let i = 0; i < allcssfiles.length; i++) {
            //log("[main] [INFO]: " + allcssfiles[i]);
            let c = fs.readFileSync(allcssfiles[i], 'utf8');
            try {
                let ast = csso.syntax.parse(c);
            } catch (err) {
                flag = 2;
                log("[main] [INFO]: XXXXX Got (" + err + ") while parsing " + allcssfiles[i]);
            }
        }

        if (flag == 2) { 
            throw "XXXXX Error parsing file syntax errors found"; 
        }

        let jst = [];
        flag = 0;
        for (let i = 0; i < jsfilesAll.length; i++) {
            //log("[main] [INFO]: " + jsfilesAll[i]);
            let c = fs.readFileSync(jsfilesAll[i], 'utf8');
            try {
                let tree = esprima.parseScript(c);

                let fmap: Record<string, any> = {} as Record<string, any>;
                for (let j = 0; j < tree.body.length; j++) {
                    if (tree.body[j].type == 'FunctionDeclaration') {
						let fdec = <estree.FunctionDeclaration> tree.body[j];
                        let fkk = fdec!.id!.name + "(" + fdec!.params!.length + ")";
                        if (fmap[fkk]) {
                            flag = 1;
                            log("[main] [INFO]: XXXXX Duplicate FunctionDeclaration function " + fkk + " in file " + jsfilesAll[i])
                        } else {
                            fmap[fkk] = true;
                        }
                    }
                }
            } catch (e) {
                if((e+"").indexOf("XXXXX Error:")!=-1) {
                    log("[main] [ERROR]: " + (e!.stack + "").replace("XXXXX Error:", "Error in file " + jsfilesAll[i] + ":"));
                } else {
                    if((e+"").indexOf("\n")!=-1) {
                        log("[main] [ERROR]: Error in file " + jsfilesAll[i] + ": " + (e+"").split("\n")[0]);
                    } else {
                        log("[main] [ERROR]: Error in file " + jsfilesAll[i] + ": ");
						log("[main] [ERROR]: " + e!.stack);
                    }
                }
                // log("[main] [INFO]: ***Syntax errors found in file " + jsfilesAll[i] +
                // ", Error is " + err);
                flag = 2;
                break;
            }
        }

        /*for (let i = 0; i < config.modules.length; i++) {
            let compressor = require('node-minify');
            minify({compressor: 'uglifyjs', input: [dirPath + config.modules[i]], output: '_t.js', sync: true,
                options: {warnings: false, mangle: false, compress: false},
                callback: function(ind) {
                    return function(err, min) {
                        if(min){}
                        else {
                            log("[main] [INFO]: Problem compacting js file " + config.modules[ind]);
                        }
                    };
                }(i)
            });
        }*/

        if (flag == 1) {
            throw "XXXXX Resolve duplicate functions issue";
        } else if (flag == 2) {
            throw "XXXXX Error parsing file syntax errors found"; 
        }

        /*let srcs = [];
        for (let i = 0; i < jsFiles[0].length; i++) {
            srcs.push(dirPath + jsFiles[0][i]);
        }*/

        processMinify(jsFileObjArr, cssFiles, config, dirPath);
    }
    if(module == "") {
    	validateJsFiles(jsFileObjArr, cssFiles, config, dirPath);
    }
}

const processMinify = async(jsFileObjArr: any, cssFiles: any, config: any, dirPath: any) => {
	// Using Google Closure Compiler
	let jsFileComp = [];
	let tempFiles = [];
	for(let k=0; k<jsFileObjArr.length; k++) {
		if(jsFileObjArr[k]["isMin"] == false) {
			let tempFileName = jsFileObjArr[k]["mname"].replace(".js", ".min.js");
			jsFileComp.push(tempFileName);
			tempFiles.push(tempFileName);
			log("[main] [INFO]: " + tempFileName);
			await minify({compressor: uglifyjs, input: jsFileObjArr[k]["name"], output: tempFileName, options: {warnings: false, mangle: false, compress: false}});
		} else {
			jsFileComp.push(jsFileObjArr[k]["name"]);
		}
	}

	let cntxt = 1;
	try {
		cntxt = 2;
		await minify({compressor: noCompress, input: jsFileComp, output: dirPath + path.sep + "out" + path.sep + 'main.js'});
		log("[main] [INFO]: Compaction of js files successfull");
		cntxt = 3;
		await minify({compressor: sqwish, input: cssFiles[1], output: dirPath + path.sep + "out" + path.sep + 'temp.css'});
		cntxt = 4;
		cssFiles[0].push(dirPath + path.sep + "out" + path.sep + 'temp.css');
		await minify({compressor: noCompress, input: cssFiles[0], output: dirPath + path.sep + "out" + path.sep + 'resources' + path.sep + 'main.css'});
		if(cntxt == 4) {
			for(var s=0; s<tempFiles.length; s++) {
				if(fs.existsSync(tempFiles[s])) {
					fs.unlinkSync(tempFiles[s]);
				}
			}
		}
		log("[main] [INFO]: Compression of css files successfull");
		//compressConfig();
	} catch (err) {
		let e;
		if(cntxt==1)e = ("Compression of js files failed with error " + err);
		else if(cntxt==2)e = ("Compaction of js files failed with error " + err);
		else if(cntxt==3)e = ("Compression of js files failed with error " + err);
		else e = ("Compaction of css files failed with error " + err);
		log("[main] [ERROR]: " + err.stack!);
		throw e;
	}
}

function compress(dirPath: any, module: any, fileName: any, type: any, cb: any, lazyValidation: any, htmlTemplates: any) {
    let t = getEssentials(dirPath, module);
    let rawHtml= t[0];
    let config= t[1];
    
    function readTiuXmlMapping(filename: any, tiuschs: any, tiutmps: any) {
        let numerrs = [0];
        let tmpdata = jsonParse(fs.readFileSync(dirPath + path.sep + filename, 'utf8'), "Error parsing "+filename+", invalid json", numerrs);
        if(numerrs[0]>0) {
            throw "Unable to read "+filename;
        }
        if(Object.keys(tmpdata).length>0) {
            Object.keys(tmpdata).forEach(function(key) {
                for(let th of tmpdata[key]) {
                    if(!th.tiles)continue;
                    for(let tile of th.tiles) {
                    	if(tile.schemaname.trim()=="")continue;
                        if(tiuschs.indexOf('modules/tiuxmls/schemas/'+tile.schemaname+'.json')==-1)tiuschs.push('modules/tiuxmls/schemas/'+tile.schemaname+'.json');
                        if(tiutmps.indexOf('modules/tiuxmls/templates/'+tile.schemaname+'.html')==-1)tiutmps.push('modules/tiuxmls/templates/'+tile.schemaname+'.html');
                    }
                }
            });
        }
    }
    
	function compressConfig(config: any, fileName: any, schemas: any, htmlTemplates: any, type: any, module: any) {
        let sc = false, tc = false, msg;
        let tiuschs: any[] = [], tiutmps: any[] = [];
        try {
        	readTiuXmlMapping(config["globals"]["tiuxmlmapping-file"], tiuschs, tiutmps);
        } catch(e) {
        }
        try {
        	readTiuXmlMapping(config["globals"]["tiuxmlmapping-ipfile"], tiuschs, tiutmps);
        } catch(e) {
        }
        try {
        	readTiuXmlMapping(config["globals"]["tiuxmlmapping-opfile"], tiuschs, tiutmps);
        } catch(e) {
        }
        if(tiuschs.length>0) {
            log("[main] [INFO]: Found only "+tiuschs.length+ " usable tiuxmls, will compress only these");
        }
        
        if(Object.keys(schemas).length>0) {
            if(tiuschs.length>0) {
                let dschemas: Record<string, any> = {} as Record<string, any>;
                let fl = 0;
                Object.keys(schemas).forEach(function(key) {
                    if(key.indexOf("/tiuxmls/")!=-1 && tiuschs.indexOf(key)!=-1) {
                        dschemas[key] = schemas[key];
                        fl++;
                    } else if(key.indexOf("/tiuxmls/")==-1) {
                        dschemas[key] = schemas[key];
                        fl++;
                    }
                });
                if(fl>0) {
                    log("[main] [INFO]: Updated total number of schemas to be compressed = " + fl);
                    schemas = dschemas;
                }
            }
            if(fileName) {
                log("[main] [INFO]: Changed/New schema file is " + fileName);
                let t = JSON.parse(fs.readFileSync(dirPath + path.sep + 'fjs-config_s.json', 'utf8'));
                t = JSON.parse(t["data"]);
                if(t.hasOwnProperty('schemas/'+fileName)) {
                    t['schemas/'+fileName] = schemas['schemas/'+fileName];
                }
                if(module != "") {
                	fs.writeFileSync(dirPath + path.sep + "out" + path.sep + 'fjs-config_'+module+'_s.json', JSON.stringify({data: JSON.stringify(t)}), 'utf8');
                } else {
                	fs.writeFileSync(dirPath + path.sep + "out" + path.sep + 'fjs-config_s.json', JSON.stringify({data: JSON.stringify(t)}), 'utf8');
                }
            } else {
                log("[main] [INFO]: Generating compressed schema file for all schemas");
                if(module != "") {
                	fs.writeFileSync(dirPath + path.sep + "out" + path.sep + 'fjs-config_'+module+'_s.json', JSON.stringify({data: JSON.stringify(schemas)}), 'utf8');
                } else {
                	fs.writeFileSync(dirPath + path.sep + "out" + path.sep + 'fjs-config_s.json', JSON.stringify({data: JSON.stringify(schemas)}), 'utf8');
                }
            }
            sc = true;
        }
        if(Object.keys(htmlTemplates).length>0) {
            if(tiutmps.length>0) {
                let dhtmlTemplates: Record<string, any> = {} as Record<string, any>;
                let fl = 0;
                Object.keys(htmlTemplates).forEach(function(key) {
                    if(key.indexOf("/tiuxmls/")!=-1 && tiutmps.indexOf(key)!=-1) {
                        dhtmlTemplates[key] = htmlTemplates[key];
                        fl++;
                    } else if(key.indexOf("/tiuxmls/")==-1) {
                        dhtmlTemplates[key] = htmlTemplates[key];
                        fl++;
                    }
                });
                if(fl>0) {
                    log("[main] [INFO]: Updated total number of templates to be compressed = " + fl);
                    htmlTemplates = dhtmlTemplates;
                }
            }
            if(fileName) {
                log("[main] [INFO]: Changed/New template file is " + fileName);
                let t = JSON.parse(fs.readFileSync(dirPath + path.sep + 'fjs-config_t.json', 'utf8'));
                t = JSON.parse(t["data"]);
                if(t.hasOwnProperty('templates/'+fileName)) {
                    t['templates/'+fileName] = htmlTemplates['templates/'+fileName];
                }
                if(module != "") {
                	fs.writeFileSync(dirPath + path.sep + "out" + path.sep + 'fjs-config_'+module+'_t.json', JSON.stringify({data: JSON.stringify(t)}), 'utf8');
                } else {
                	fs.writeFileSync(dirPath + path.sep + "out" + path.sep + 'fjs-config_t.json', JSON.stringify({data: JSON.stringify(t)}), 'utf8');
                }
            } else {
                log("[main] [INFO]: Generating compressed template file for all templates");
                if(module != "") {
                	fs.writeFileSync(dirPath + path.sep + "out" + path.sep + 'fjs-config_'+module+'_t.json', JSON.stringify({data: JSON.stringify(htmlTemplates)}), 'utf8');
                } else {
                	fs.writeFileSync(dirPath + path.sep + "out" + path.sep + 'fjs-config_t.json', JSON.stringify({data: JSON.stringify(htmlTemplates)}), 'utf8');
                }
            }
            tc = true;
        }
        config.compressedScript = true;
        config.compressedSchemasFile = true;
        config.compressedCompiledSchemaHtmlTemplatesFile = true;
        config.schemas = undefined;
        config.templates = undefined;
        config.modules = undefined;
        fs.writeFileSync(dirPath + path.sep + "out" + path.sep + 'fjs-config_prod.json', JSON.stringify(config), 'utf8');
        if(cb)cb(sc, tc, msg);
    }
    
    let schemas = {}, sc, tc;
    
    if(type==3) {
        fileName = 'tiuxmls/' + fileName.substring(0, fileName.lastIndexOf(".")) + ".json"
    }
    
    if(type!==2) {
        sc = [0];
        schemas = compressSchemas(config, fileName, type, dirPath, sc);
        log("[main] [INFO]: Total number of schemas to be compressed = " + sc[0]);
    }
    
    if(type==3) {
        fileName = fileName.substring(0, fileName.lastIndexOf(".")) + ".html"
    }
    
    if(type!=1) {
    	tc = [0];
    	compressTemplates(config, fileName, type, schemas, dirPath, tc, lazyValidation, htmlTemplates);
    	log("[main] [INFO]: Total number of templates to be compressed = " + tc[0]);
    }

	if(type==5) {
		return;
	}

    if(type==4 && module == "") {
        compressJsCss(rawHtml, config, dirPath, schemas, htmlTemplates, module);
		compressConfig(config, fileName, schemas, htmlTemplates, type, module);
    } else {
        compressConfig(config, fileName, schemas, htmlTemplates, type, module);
    }
}

function compressAll(dirPath: any, progressFunc: any) {
	let htmlTemplates = {};
	if(fs.existsSync(dirPath + path.sep + "out")) {
		fs.rmdirSync(dirPath + path.sep + "out", {recursive: true});
	}
	fs.mkdirSync(dirPath + path.sep + "out");
	fs.mkdirSync(dirPath + path.sep + "out" + path.sep + "resources");
	fs.mkdirSync(dirPath + path.sep + "out" + path.sep + "js");
	fs.mkdirSync(dirPath + path.sep + "out" + path.sep + "resources" + path.sep + "cldr");
	fs.mkdirSync(dirPath + path.sep + "out" + path.sep + "resources" + path.sep + "globalize");

	let tot = 1;
	const mods: string[] = [];
	if (fs.existsSync(dirPath+path.sep+"modules")) {
		fs.readdirSync(dirPath+path.sep+"modules").forEach(module => {
			if(fs.lstatSync(dirPath+path.sep+"modules"+path.sep+module).isDirectory()) {
				mods.push(module);
			}
		});
	}
	tot += mods.length;

	compress(dirPath, "", undefined, 4, undefined, false, htmlTemplates);
	progressFunc(1/tot*100);

	for(const mod of mods) {
		compress(dirPath, mod, undefined, 4, undefined, false, htmlTemplates);
		progressFunc(1/tot*100);
	}
}

function gatherTemplates(dirPath: any, htmlTemplates: Record<string, any>) {
	compress(dirPath, "", undefined, 5, undefined, true, htmlTemplates);
	if (fs.existsSync(dirPath+path.sep+"modules")) {
		fs.readdirSync(dirPath+path.sep+"modules").forEach(module => {
			if(fs.lstatSync(dirPath+path.sep+"modules"+path.sep+module).isDirectory()) {
				compress(dirPath, module, undefined, 5, undefined, true, htmlTemplates);
			}
		});
	}
}