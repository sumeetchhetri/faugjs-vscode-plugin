import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import FastGlob = require("fast-glob");
import * as cr from 'crypto';
import * as vm from 'vm';
import * as jsb from 'js-beautify';
import  * as wk from 'worker_threads';
const fgt:any = require('./faug-templatize.js');
let compressInProgress = false;

//https://stackoverflow.com/questions/62453615/vscode-open-a-file-in-a-specific-line-number-using-js
export function activate(context: vscode.ExtensionContext) {
	const worker = new wk.Worker(context.asAbsolutePath("compress_worker.js"));

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
		
		const fappspath = vscode.workspace.workspaceFolders[0].uri.fsPath + "/.faugjs-apps.json";
		if(fs.existsSync(fappspath)) {
			fjscPaths = JSON.parse(fs.readFileSync(fappspath, "utf8"));
			isMulti = true;
			console.log("Found multiple config locations => " + fjscPaths.join(" "));
			for(const fjscp of fjscPaths) {
				const lst = await FastGlob(['**.json', '**.js'], { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath+"/"+fjscp });
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
				fgt.gatherTemplates(fjs.basePath!.fsPath, fjs.templateList);
				if (vscode.window.activeTextEditor) {
					const doc = vscode.window.activeTextEditor!.document;
					if (doc.uri.fsPath.endsWith(".html")) {
						validateFjsTemplate(fjstemplatedgcoll, false);
					}
				}
			} catch (error) {
				console.error(error);
			}

			fjs.configList.push(fjs.fjcuri!.fsPath);

			const fjsconfigs: Array<string> = [];
			fs.readdirSync(fjs.basePath!.fsPath).forEach(file => {
				const fn = file.substring(file.lastIndexOf("/")+1);
				if(fn.startsWith("fjs-config_") && fn.endsWith(".json")) {
					if(!fn.endsWith("_t.json") && !fn.endsWith("_s.json") && !fn.endsWith("_prod.json")) {
						fjsconfigs.push(fn);
						const uri = vscode.Uri.joinPath(fjs.basePath!, file);
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

			console.time('Parse Config Files for location ' + fjs.basePath!.fsPath);
			let symbols = await loadSymbolsForFile(fjs.fjcuri!, true);
			fjs.parseJsonFile(fjs.fjcuri!, symbols);
			//console.log(fjs.jsonFilesSymbolList);
			doneUnits += 1;
			let percent = doneUnits/totalUnits*pperc;
			if(percent>1) {
				progress.report({increment: percent});
				progressedUnits = percent;
				//console.log(doneUnits+"/"+totalUnits+" => "+percent);
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
					//console.log(doneUnits+"/"+totalUnits+" => "+percent);
				}
			}
			console.timeEnd('Parse Config Files for location ' + fjs.basePath!.fsPath);

			console.time('Parse Module Files for location ' + fjs.basePath!.fsPath);
			const uri = vscode.Uri.joinPath(fjs.basePath!, "faug-min.js");
			symbols = await loadSymbolsForFile(uri, true);
			fjs.parseJsFile(uri, symbols);
			doneUnits += 11;
			percent = doneUnits/totalUnits*pperc;
			if(percent-progressedUnits>1) {
				progress.report({increment: percent-progressedUnits});
				progressedUnits = percent;
				//console.log(doneUnits+"/"+totalUnits+" => "+percent);
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
						//console.log(doneUnits+"/"+totalUnits+" => "+percent);
					}
				}
				
				fjs.jsrefcontents = "";
				fjs.jsrefcontentslines = 0;
				for (const jsf in fjs.jsFilesFuncList) {
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
				fjs.moduleList = tree["modules"];
			}
			//await parseModuleFiles(tree, basePath);
			console.timeEnd('Parse Module Files for location ' + fjs.basePath!.fsPath);

			console.time('Parse Schema Files for location ' + fjs.basePath!.fsPath);
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
						//console.log(doneUnits+"/"+totalUnits+" => "+percent);
					}
				}
			}

			fjs.isReady = true;

			console.timeEnd('Parse Schema Files for location ' + fjs.basePath!.fsPath);
	
			console.log("Found " + (fjsconfigs.length + 1) + " config files for location " + fjs.basePath!.fsPath);
			console.log("Found " + fjs.moduleList.length + " module files for location " + fjs.basePath!.fsPath);
			console.log("Found " + Object.keys(fjs.schemaList).length + " schema files for location " + fjs.basePath!.fsPath);
			console.log("Found " + Object.keys(fjs.templateList).length + " template files for location " + fjs.basePath!.fsPath);
			console.log("Found " + Object.keys(tree["router"]!["routes"]!).length + " routes for location " + fjs.basePath!.fsPath);
			console.log("Found " + Object.keys(tree["globals"]!).length + " globals for location " + fjs.basePath!.fsPath);		
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
					validateFjsTemplate(fjstemplatedgcoll, false);
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
					validateFjsTemplate(fjstemplatedgcoll, false);
				}
			})
		);
	
		/*context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument(e => {
				if (e && e.document.uri.fsPath.endsWith(".html")) {
					validateFjsTemplate(fjstemplatedgcoll, false);
				}
			})
		);*/
	
		context.subscriptions.push(
			vscode.workspace.onDidCloseTextDocument(doc => fjstemplatedgcoll.delete(doc.uri))
		);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('faugjs.template.validate', () => {
			validateFjsTemplate(fjstemplatedgcoll, true);
		})
	);

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
							//console.log("parent: " + JSON.stringify(result));
							if(result.status=='done') {
								progress.report({increment: 100});
								vscode.window.showInformationMessage('Compressing faujs app [' + fjs.fjspath + '] completed');
								resolve(null);
								compressInProgress = false;
							} else if(result.status=='progress') {
								progress.report({increment: Math.floor(result.by)});
							}
						});
						
						worker.on("error", error => {
							//console.log("parent-error: " + error);
							progress.report({increment: 100});
							vscode.window.showInformationMessage('Compressing faujs app [' + fjs.fjspath + '] failed');
							console.log(error);
							resolve(null);
							compressInProgress = false;
						});
						//Without worker thread
						/*try {
							fgt.compressAll(fjs.basePath!.fsPath, (by: number)=> {
								progress.report({increment: Math.floor(by)});
							});
						} catch (error) {
							console.log(error);
						}
						compressInProgress = false;*/
					});
				});
			} else if(fjs) {
				vscode.window.showInformationMessage("Faugjs setup in progress, please try after setup is complete..");
			}
		})
	);

	//https://developpaper.com/the-function-of-jump-to-definition-automatic-completion-and-hover-prompt-of-vscode-plug-in-development-strategy/
	var defJsProvider = vscode.languages.registerDefinitionProvider({scheme: 'file', language: 'javascript'}, {
		//console.log("in hover")
		provideDefinition(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
			const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc)!;
			return fjs.findDefinition(doc, position, false);
		}
	});
	context.subscriptions.push(defJsProvider);

	var complJsProvider = vscode.languages.registerCompletionItemProvider({scheme: 'file', language: 'javascript'}, {
		//console.log("in hover")
		provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.CompletionItem[] | undefined {
			const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc)!;
			if(!fjs.isModule(doc.uri)) {
				vscode.window.showInformationMessage("Faugjs setup in progress, please try after modules (js files) are initialized..");
				return undefined;
			}
			const [word1, word2] = getWords(doc, position);
			//console.log(word1 + " " + word2);
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
			//console.log(clist);
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
				if(!fjs || !fjs.isReady) {
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
							//console.log("globals => "+vname);
						} else {
							vname = ld.detail.substring(9, ld.detail.indexOf(")"));
							//console.log("globals => "+vname);
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
								//console.log("globals_extract => "+vname);
								return searchWithRegex(fjs, vname, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
							}
						} else if(word.indexOf("gvar@")!=-1) {
							const vname = word.substring(word.indexOf("gvar@")+5);
							if(vname) {
								//console.log("globals_extract => "+word);
								return searchWithRegex(fjs, vname, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
							}
							
						} else if(word.indexOf("<%")!=-1) {
							//console.log("var_extract => "+word);
						} else if(props && props[word.substring(1, word.length-1)]) {
							return props[word.substring(1, word.length-1)][""]["location"];
						}
					}
				}
			} catch (error) {
				console.error(error);
			}
			return undefined;
		}
	});
	context.subscriptions.push(defJsonProvider);
}

function validateFjsTemplate(fjstemplatedgcoll: vscode.DiagnosticCollection, fromCmd: boolean) {
	const doc = vscode.window.activeTextEditor!.document;
	const fjs = FaugJsConfigStore.getFaugJsConfigStore(doc);
	const tname = fjs!.getTemplate(doc.uri.fsPath);
	if(fjs && tname && fjs.jsrefcontents) {
		let out;
		const type = fjs.templateList[tname];
		try {
			let tmplvars;
			if (type == 0) {
				tmplvars = {rows: [], options: {}};
				out = fgt.faugX(fjs.basePath!.fsPath, {}, tname, tmplvars, false, false, true);
			} else if (type == 1 || type == 2) {
				tmplvars = {isTransient: false, elName: '', rows: [], selectedVal: '', details: '', vars: {}, options: {}};
				out = fgt.faugX(fjs.basePath!.fsPath, {}, tname, tmplvars, false, false, true);
			} else if (type == 3 || type == 5) {
				tmplvars = fjs.templateList[tname][1];
				out = fgt.faugX(fjs.basePath!.fsPath, {}, tname, tmplvars, false, false, true);
			} else if (type == 4) {
				tmplvars = fjs.templateList[tname][1];
				out = fgt.faugX(fjs.basePath!.fsPath, {}, tname, tmplvars, false, true, true);
			}

			//SyntaxError: Unexpected token ';'
			//ReferenceError:
			// is not defined
			//Unexpected end of input
			//Unexpected identifier
			//https://github.com/microsoft/vscode-extension-samples/blob/main/code-actions-sample/src/diagnostics.ts
			out[3] = out[3].replace(new RegExp('____r_____\\.push\\("', 'g'), '\n____r_____.push("');
			out[3] = out[3].replace('return ____r_____.join("");', '');
			let isvalid = true;
			try {
				const exlines = fjs.jsrefcontentslines! + 2 + Object.keys(tmplvars).length + 1;
				out[3] = fjs.jsrefcontents + "\n\n" + jsb.js_beautify(out[3], { indent_size: 4, space_in_empty_paren: true });
				vm.runInNewContext(out[3], {arg: tmplvars}, {lineOffset: -exlines, filename: tname, displayErrors: true});
				fjstemplatedgcoll.set(doc.uri, []);
			} catch(e) {
				//console.error(e);
				const ep = e.stack.toString().split("\n");
				if(ep[4].startsWith("SyntaxError") || ep[4].startsWith("ReferenceError") || ep[4].endsWith("is not a function")) {
					let li = ep[0].substring(ep[0].lastIndexOf(":")+1) * 1;
					if(ep[1].indexOf("____r_____.push(")!=-1) {
						li = li-1;
					}
					const range = doc.lineAt(li-1).range;
					const diagnostic = new vscode.Diagnostic(range, ep[4], vscode.DiagnosticSeverity.Error);
					fjstemplatedgcoll.set(doc.uri, [diagnostic]);
					isvalid = false;
				} else {
					fjstemplatedgcoll.set(doc.uri, []);
				}
				//console.log(ep[0]);
				//console.log(ep[4]);
			}
			if(isvalid && fromCmd) {
				vscode.window.showInformationMessage("Faugjs template " + tname + " is valid");
			}
		} catch (error) {
			console.log(error);
		}
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
		if(!fs.existsSync(fjcuri.path)) {
			fjcuri = vscode.Uri.joinPath(basePath, "src", "fjs-config.json");
			if(!fs.existsSync(fjcuri.path)) {
				fjcuri = vscode.Uri.joinPath(basePath, "public", "fjs-config.json");
				if(!fs.existsSync(fjcuri.path)) {
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

	if(fs.existsSync(fjcuri.path)) {
		fjs.init(basePath, fjcuri, fjspath);
	} else {
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
	//console.log("json: " + jsonE!.isActive);
	const jsE = vscode.extensions.getExtension("vscode.javascript");
	await jsE!.activate();
	//console.log("javascript: " + jsE!.isActive);
}

async function loadSymbolsForFile(uri: vscode.Uri, wait: boolean = false): Promise<vscode.DocumentSymbol[]> {
	//console.log("Loading symbols for file => " + uri.fsPath);
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

async function parseModuleFiles(fjs: FaugJsConfigStore, tree: Record<string, any>, basePath: vscode.Uri, progress: vscode.Progress<{
    message?: string | undefined;
    increment?: number | undefined;
}>) {
	if(tree["modules"] && tree["modules"].length>0) {
		for (const mod of tree["modules"]) {
			const uri = vscode.Uri.joinPath(basePath, mod);
			const symbols = await loadSymbolsForFile(uri, false);
			fjs.parseJsFile(uri, symbols);
		}
		fjs.moduleList = tree["modules"];
	}
}

function gatherSchemaAndTemplateFiles(fjs: FaugJsConfigStore, tree: Record<string, any>, stgJschFpLst: Array<string>, fjscp: string) {
	if(tree["schemas"]) {
		for (const schname in tree["schemas"]) {
			try {
				fjs.schemaList[schname] = vscode.Uri.joinPath(fjs.basePath!, tree["schemas"][schname][0]).fsPath;
				stgJschFpLst.push("/"+fjscp+"/"+tree["schemas"][schname][0]);
			} catch (error) {
				console.error(error);
			}
		}
	}
}

function isPossibleFuncLabel(ld: any): boolean {
	if(/^(func|outfunc|serializeFunc|onValidateOp|beforeOp|afterDraw)$/.test(ld!.name)) {
		return true;
	} else if(/.*\.(func|outfunc|serializeFunc|onValidateOp|beforeOp|afterDraw)$/.test(ld!.name)) {
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
	//console.log(word2);
	const rg = doc.getWordRangeAtPosition(wr.start.translate(0, -1));
	if(rg) {
		word1 = doc.getText(rg);
		word1 = word1=="Fg"?"Faug":word1;
		//console.log(word1);
	}
	return [word1, word2];
}

function handleTemFuncCrudOps(fjs: FaugJsConfigStore, doc: vscode.TextDocument, position: vscode.Position, ld: any): vscode.Location | undefined {
	if(isTemplateLabel(ld)) {
		const uri = vscode.Uri.joinPath(fjs.basePath!, ld!.detail);
		return new vscode.Location(uri, new vscode.Position(0, 0));
	} else if(isPossibleFuncLabel(ld)) {
		return fjs.findDefinition(doc, position, true);
	} else {
		if(ld!.name=="op" || ld!.name=="viewerId") {
			let cnt = position.line - 2;
			while(cnt<position.line + 2) {
				let scld = fjs.jsonFilesSymbolList[doc.uri.fsPath+"_linesinfo"][cnt++];
				if(scld && scld!.name=="schemaName") {
					const uripath = fjs.schemaList[scld!.detail];
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
			const uri = vscode.Uri.file(fjs.schemaList[ld!.detail]);
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
			if(path.endsWith(this.schemaList[schname])) {
				return true;
			}
		}
		return false;
	}

	public validateTemplate(doc: vscode.TextDocument) {
		try {
			fgt.templatize(doc.getText(), undefined, undefined, undefined, undefined);
		} catch (error) {
			console.error(error);
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
		const match = /(Fg|Faug)[\t ]*\.[\t ]*(routeTo|r|getGlobalVar|g|invokeCrudOp|ic|templatize|templatizeByName)[\t ]*\([\t ]*('|")(.+)('|")(.*)/.exec(line.text);
		if(match && match.length==7) {
			let arg = match[4].trim();
			if(match[2]=="routeTo" || match[2]=="r") {
				return getRouteLocation(this, undefined, arg);
			} else if(match[2]=="getGlobalVar" || match[2]=="g") {
				return searchWithRegex(this, arg, "(Faug|Fg)\\.(g|getGlobalVar)\\((\"|')", "*.js");
			} else if(match[2]=="invokeCrudOp" || match[2]=="ic") {
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
		//console.log("Parsing js module file => " + uri.fsPath);
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
				console.error(error);
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
