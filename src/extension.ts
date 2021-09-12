import * as vscode from 'vscode';
import * as path from 'path';
import { Console } from 'console';
import * as fs from 'fs';

//https://stackoverflow.com/questions/62453615/vscode-open-a-file-in-a-specific-line-number-using-js
export function activate(context: vscode.ExtensionContext) {
	//https://github.com/mjcrouch/vscode-activator/blob/master/package.json
	/*const exts = vscode.workspace
        .getConfiguration("activator")
        .get<string[]>("activateOnStart", []);*/
	//const exts = ["vscode.json", "vscode.javascript"];
	vscode.window.withProgress({
		location: vscode.ProgressLocation.Window,
		cancellable: false,
		title: 'Setting up faugjs'
	}, async (progress) => {
		progress.report({increment: 0});
		
		loadExtensions();

		if(vscode.workspace.workspaceFolders === undefined) return;

		const [basePath, fjcuri] = resolveBasePath();
		if(basePath) {
			FaugJsConfigStore.basePath = basePath;
		} else {
			progress.report({ increment: 100 });
			vscode.window.showInformationMessage("Faugjs setup haldted due to issues");
			return;
		}

		let totalUnits = 0;
		let doneUnits = 0;
		let progressedUnits = 0;

		FaugJsConfigStore.configList.push((<vscode.Uri>fjcuri).fsPath);

		const fjsconfigs: Array<string> = [];
		fs.readdirSync(basePath.fsPath).forEach(file => {
			const fn = file.substring(file.lastIndexOf("/")+1);
			if(fn.startsWith("fjs-config_") && fn.endsWith(".json")) {
				if(!fn.endsWith("_t.json") && !fn.endsWith("_s.json") && !fn.endsWith("_prod.json")) {
					fjsconfigs.push(fn);
					const uri = vscode.Uri.joinPath(FaugJsConfigStore.basePath, file);
					FaugJsConfigStore.configList.push(uri.fsPath);
				}
			}
		});

		const document = await vscode.workspace.openTextDocument(fjcuri);
		const tree = JSON.parse(document.getText());

		totalUnits += fjsconfigs.length + 1;
		if(tree["modules"] && tree["modules"].length>0) {
			totalUnits += tree["modules"].length * 11;
		}

		gatherSchemaAndTemplateFiles(tree);
		for(const fjsc of fjsconfigs) {
			const uri = vscode.Uri.joinPath(basePath, fjsc);
			const document = await vscode.workspace.openTextDocument(uri);
			const mtree = JSON.parse(document.getText());
			gatherSchemaAndTemplateFiles(mtree);
		}
		totalUnits += Object.keys(FaugJsConfigStore.schemaList).length;

		console.time('Parse Config Files');
		let symbols = await loadSymbolsForFile(fjcuri, true);
		FaugJsConfigStore.parseJsonFile(fjcuri, symbols);
		//console.log(FaugJsConfigStore.jsonFilesSymbolList);
		doneUnits += 1;
		let percent = doneUnits/totalUnits*100;
		if(percent>1) {
			progress.report({increment: percent});
			progressedUnits = percent;
			//console.log(doneUnits+"/"+totalUnits+" => "+percent);
		}

		for(const fjsc of fjsconfigs) {
			const uri = vscode.Uri.joinPath(basePath, fjsc);
			const symbols = await loadSymbolsForFile(uri, false);
			FaugJsConfigStore.parseJsonFile(uri, symbols);
			doneUnits += 1;
			percent = doneUnits/totalUnits*100;
			if(percent-progressedUnits>1) {
				progress.report({increment: percent-progressedUnits});
				progressedUnits = percent;
				//console.log(doneUnits+"/"+totalUnits+" => "+percent);
			}
		}
		console.timeEnd('Parse Config Files');

		console.time('Parse Module Files');
		const uri = vscode.Uri.joinPath(basePath, "faug-min.js");
		symbols = await loadSymbolsForFile(uri, true);
		FaugJsConfigStore.parseJsFile(uri, symbols);
		doneUnits += 11;
		percent = doneUnits/totalUnits*100;
		if(percent-progressedUnits>1) {
			progress.report({increment: percent-progressedUnits});
			progressedUnits = percent;
			//console.log(doneUnits+"/"+totalUnits+" => "+percent);
		}

		if(tree["modules"] && tree["modules"].length>0) {
			for (const mod of tree["modules"]) {
				const uri = vscode.Uri.joinPath(basePath, mod);
				const symbols = await loadSymbolsForFile(uri, false);
				FaugJsConfigStore.parseJsFile(uri, symbols);
				doneUnits += 11;
				percent = doneUnits/totalUnits*100;
				if(percent-progressedUnits>1) {
					progress.report({increment: percent-progressedUnits});
					progressedUnits = percent;
					//console.log(doneUnits+"/"+totalUnits+" => "+percent);
				}
			}
			FaugJsConfigStore.moduleList = tree["modules"];
		}
		//await parseModuleFiles(tree, basePath);
		console.timeEnd('Parse Module Files');

		console.time('Parse Schema Files');
		if(FaugJsConfigStore.schemaList) {
			for (const schname in FaugJsConfigStore.schemaList) {
				const uri = vscode.Uri.file(FaugJsConfigStore.schemaList[schname]);
				const symbols = await loadSymbolsForFile(uri, false);
				FaugJsConfigStore.parseJsonFile(uri, symbols);
				doneUnits += 1;
				percent = doneUnits/totalUnits*100;
				if(percent-progressedUnits>1) {
					progress.report({increment: percent-progressedUnits});
					progressedUnits = percent;
					//console.log(doneUnits+"/"+totalUnits+" => "+percent);
				}
			}
		}
		console.timeEnd('Parse Schema Files');

		console.log("Found " + (fjsconfigs.length + 1) + " config files");
		console.log("Found " + FaugJsConfigStore.moduleList.length + " module files");
		console.log("Found " + Object.keys(FaugJsConfigStore.schemaList).length + " schema files");
		console.log("Found " + FaugJsConfigStore.templateList.length + " template files");
		console.log("Found " + Object.keys(tree["router"]!["routes"]!).length + " routes");
		console.log("Found " + Object.keys(tree["globals"]!).length + " globals");

		progress.report({increment: 100});
		vscode.window.showInformationMessage("Faugjs setup completed");
	});

	/*vscode.workspace.onDidOpenTextDocument((d)=> {
		const fjpi = d.fileName.lastIndexOf("fjs-config");
		if(fjpi!=-1) {
			let fn = d.fileName.substring(fjpi);
					vscode.window.showInformationMessage("[Document Opened]:" + path.basename(d.fileName));
		}
	});*/

	/*var hoverProvider = vscode.languages.registerHoverProvider({ scheme: 'file', language: 'javascript' }, {
		//console.log("in hover")
		provideHover(doc: vscode.TextDocument) {
			return new vscode.Hover('For *all* TypeScript documents.');
		}
	});
	context.subscriptions.push(hoverProvider);*/

	//https://developpaper.com/the-function-of-jump-to-definition-automatic-completion-and-hover-prompt-of-vscode-plug-in-development-strategy/
	var defJsProvider = vscode.languages.registerDefinitionProvider({scheme: 'file', language: 'javascript'}, {
		//console.log("in hover")
		provideDefinition(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
			return FaugJsConfigStore.findDefinition(doc, position, false);
		}
	});
	context.subscriptions.push(defJsProvider);

	var complJsProvider = vscode.languages.registerCompletionItemProvider({scheme: 'file', language: 'javascript'}, {
		//console.log("in hover")
		provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.CompletionItem[] | undefined {
			if(!FaugJsConfigStore.isModule(doc.uri)) return undefined;
			const [word1, word2] = getWords(doc, position);
			console.log(word1 + " " + word2);
			if(word2.length<3) return undefined;

			const clist: vscode.CompletionItem[] = [] as vscode.CompletionItem[];
			for(const filename in FaugJsConfigStore.jsFilesFuncList) {
				let w2lst;
				if(word1 && FaugJsConfigStore.jsFilesFuncList[filename] && FaugJsConfigStore.jsFilesFuncList[filename][word1]) {
					w2lst = FaugJsConfigStore.jsFilesFuncList[filename][word1];
				} else if(FaugJsConfigStore.jsFilesFuncList[filename]) {
					w2lst = FaugJsConfigStore.jsFilesFuncList[filename];
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
			console.log(clist);
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
				w2lst = FaugJsConfigStore.jsFilesFuncList[filename][word1];
			} else {
				w2lst = FaugJsConfigStore.jsFilesFuncList[filename];
			}*/
			return null;
		}
	});
	context.subscriptions.push(complJsProvider);

	/*var defJsonHighlighter = vscode.languages.registerDocumentHighlightProvider({ scheme: 'file', language: 'json' }, {
		//console.log("in hover")
		provideDocumentHighlights(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
			const fjpi = doc.fileName.lastIndexOf("fjs-config");
			if (fjpi == -1) {
				return null;
			}

			let fn = doc.fileName.substring(fjpi);
			vscode.window.showInformationMessage("[Document Opened]:" + path.basename(doc.fileName));

			try {
				console.log(position);
				let line = doc.lineAt(position.line);
				console.log(line);
				console.log(token);
			} catch (error) {
				console.error(error);
			}
			return new vscode.Location(vscode.Uri.file("abc"), {
				start: { line: 2, character: 5 },
				end: { line: 2, character: 6 }
			});
		}
	});
	context.subscriptions.push(defJsonHighlighter);*/

	var defJsonProvider = vscode.languages.registerDefinitionProvider({ scheme: 'file', language: 'json' }, {
		provideDefinition(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
			try {
				let isfjsconfig = FaugJsConfigStore.configList.indexOf(doc.uri.fsPath)!=-1;
				if (isfjsconfig) {
					let ld = FaugJsConfigStore.jsonFilesSymbolList[doc.uri.fsPath+"_linesinfo"][position.line];
					if(/template|func|op|schemaName|viewerId/.test(ld!.name)) {
						return handleTemFuncCrudOps(doc, position, ld);
					} else {
						const wr = doc.getWordRangeAtPosition(position)!;
						let word = doc.getText(wr);
						if(!ld!.detail) {
							let cnt = position.line;
							while(cnt>0) {
								ld = FaugJsConfigStore.jsonFilesSymbolList[doc.uri.fsPath+"_linesinfo"][--cnt];
								if(ld && ld!.kind==vscode.SymbolKind.Array) {
									if(word.endsWith(".json\"")) {
										return handleTemFuncCrudOps(doc, position, {name: "__sf__", detail: word.substring(1, word.length-1)});
									} else if(word.endsWith(".js\"")) {
										return handleTemFuncCrudOps(doc, position, {name: "__mf__", detail: word.substring(1, word.length-1)});
									} else if(word.endsWith(".html\"")) {
										return handleTemFuncCrudOps(doc, position, {name: "templateFile", detail: word.substring(1, word.length-1)});
									}
									break;
								}
							}
						}
					} 
				} else if(FaugJsConfigStore.isSchema(doc.uri.fsPath)) {
					let ld = FaugJsConfigStore.jsonFilesSymbolList[doc.uri.fsPath+"_linesinfo"][position.line];
					if(isPossibleFuncLabel(ld) || isTemplateLabel(ld) || isSchemaLabel(ld)) {
						return handleTemFuncCrudOps(doc, position, ld);
					} else if(ld.name=="target") {
						let props = FaugJsConfigStore.jsonFilesSymbolList[doc.uri.fsPath]["properties"];
						if(props && props[ld.detail]) {
							return props[ld.detail][""]["location"];
						}
					} else if(ld.name=="fromVar") {
						return searchWithRegex(ld.detail, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
					} else if(ld.name=="routeTo") {
						const fjcuri = vscode.Uri.joinPath(FaugJsConfigStore.basePath, "fjs-config.json");
						let router = FaugJsConfigStore.jsonFilesSymbolList[fjcuri.fsPath]["router"];
						if(router && router["routes"]) {
							for(const rkey in router["routes"]) {
								const rkeypre = rkey.substring(0, rkey.indexOf("/"));
								const ldpre = ld.detail.substring(0, ld.detail.indexOf("/"));
								if(ldpre==rkeypre) {
									return router["routes"][rkey][""]["location"];
								}
							}
							return router["routes"][ld.detail][""]["location"];
						}
					} else if(ld.detail && (ld.detail.startsWith("%%Fg.g(") || ld.detail.startsWith("%%Faug.g("))) {
						let vname = undefined;
						if(ld.detail.startsWith("%%Fg.g(")) {
							vname = ld.detail.substring(7, ld.detail.indexOf(")"));
							console.log("globals => "+vname);
						} else {
							vname = ld.detail.substring(9, ld.detail.indexOf(")"));
							console.log("globals => "+vname);
						}
						if(vname) {
							return searchWithRegex(vname, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
						}
					} else {
						let props = FaugJsConfigStore.jsonFilesSymbolList[doc.uri.fsPath]["properties"];
						const wr = doc.getWordRangeAtPosition(position)!;
						let word = doc.getText(wr);
						if(word.startsWith("\"func:")) {
							return FaugJsConfigStore.resolvePossibleFunction(doc, undefined, word.substring(6, word.length-1));
						} else if(word.indexOf("%%Fg.g")!=-1 || word.indexOf("%%Faug.g(")!=-1) {
							let vname = undefined;
							if(word.indexOf("%%Fg.g")!=-1) {
								vname = word.substring(word.indexOf("%%Fg.g")+7, word.indexOf(")", word.indexOf("%%Fg.g")+7));
							} else {
								vname = word.substring(word.indexOf("%%Faug.g")+9, word.indexOf(")", word.indexOf("%%Faug.g")+9));
							}
							if(vname) {
								console.log("globals_extract => "+vname);
								return searchWithRegex(vname, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
							}
						} else if(word.indexOf("gvar@")!=-1) {
							const vname = word.substring(word.indexOf("gvar@")+5);
							if(vname) {
								console.log("globals_extract => "+word);
								return searchWithRegex(vname, "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')", "*.js");
							}
							
						} else if(word.indexOf("<%")!=-1) {
							console.log("var_extract => "+word);
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

function resolveBasePath(): Array<any> {
	if(vscode.workspace && vscode.workspace.workspaceFolders) {
		let basePath = vscode.workspace.workspaceFolders[0].uri;
		let fjcuri = vscode.Uri.joinPath(basePath, "fjs-config.json");
		if(!fs.existsSync(fjcuri.path)) {
			fjcuri = vscode.Uri.joinPath(basePath, "src", "fjs-config.json");
			if(!fs.existsSync(fjcuri.path)) {
				fjcuri = vscode.Uri.joinPath(basePath, "public", "fjs-config.json");
				if(!fs.existsSync(fjcuri.path)) {
					fjcuri = vscode.Uri.joinPath(basePath, "static", "fjs-config.json");
					basePath = vscode.Uri.joinPath(basePath, "static");
				} else {
					basePath = vscode.Uri.joinPath(basePath, "public");
				}
			} else {
				basePath = vscode.Uri.joinPath(basePath, "src");
			}
		}
		return [basePath, fjcuri];
	}
	return [];
}

function searchWithRegex(name: string, srchRegexPrefix: string, incFiles: string): vscode.Location | undefined {
	const fjcuri = vscode.Uri.joinPath(FaugJsConfigStore.basePath, "fjs-config.json");
	let globals = FaugJsConfigStore.jsonFilesSymbolList[fjcuri.fsPath]["globals"];
	if(globals && globals[name]) {
		return globals[name][""]["location"];
	} else {
		vscode.commands.executeCommand("workbench.action.findInFiles", {
			query: "(Faug|Fg)\\.(ag|addGlobalVar)\\((\"|')" + name,
			triggerSearch: true,
			isRegex: true,
			filesToInclude: incFiles
		});
	}
	return undefined;
}

async function loadExtensions() {
	const jsonE = vscode.extensions.getExtension("vscode.json");
	await jsonE!.activate();
	console.log("json: " + jsonE!.isActive);
	const jsE = vscode.extensions.getExtension("vscode.javascript");
	await jsE!.activate();
	console.log("javascript: " + jsE!.isActive);
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

async function parseModuleFiles(tree: Record<string, any>, basePath: vscode.Uri, progress: vscode.Progress<{
    message?: string | undefined;
    increment?: number | undefined;
}>) {
	if(tree["modules"] && tree["modules"].length>0) {
		for (const mod of tree["modules"]) {
			const uri = vscode.Uri.joinPath(basePath, mod);
			const symbols = await loadSymbolsForFile(uri, false);
			FaugJsConfigStore.parseJsFile(uri, symbols);
		}
		FaugJsConfigStore.moduleList = tree["modules"];
	}
}

function gatherSchemaAndTemplateFiles(tree: Record<string, any>) {
	if(tree["schemas"]) {
		for (const schname in tree["schemas"]) {
			try {
				FaugJsConfigStore.schemaList[schname] = vscode.Uri.joinPath(FaugJsConfigStore.basePath, tree["schemas"][schname][0]).fsPath;
			} catch (error) {
				console.error(error);
			}
		}
	}
	if(tree["templates"] && tree["templates"].length>0) {
		for(const tmpl of tree["templates"]) {
			try {
				FaugJsConfigStore.templateList.push(vscode.Uri.joinPath(FaugJsConfigStore.basePath, tmpl).fsPath);
			} catch (error) {
				if(tmpl instanceof Array) {
					FaugJsConfigStore.templateList.push(vscode.Uri.joinPath(FaugJsConfigStore.basePath, tmpl[0]).fsPath);
				} else {
					console.error(error);
				}
			}
		}
	}
}

function isPossibleFuncLabel(ld: any): boolean {
	if(/^(func|serializeFunc|onValidateOp|beforeOp|afterDraw)$/.test(ld!.name)) {
		return true;
	} else if(/.*\.(func|serializeFunc|onValidateOp|beforeOp|afterDraw)$/.test(ld!.name)) {
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
		//console.log(word1);
	}
	return [word1, word2];
}

function handleTemFuncCrudOps(doc: vscode.TextDocument, position: vscode.Position, ld: any): vscode.Location | undefined {
	if(isTemplateLabel(ld)) {
		const uri = vscode.Uri.joinPath(FaugJsConfigStore.basePath, ld!.detail);
		return new vscode.Location(uri, new vscode.Position(0, 0));
	} else if(isPossibleFuncLabel(ld)) {
		return FaugJsConfigStore.findDefinition(doc, position, true);
	} else {
		if(ld!.name=="op" || ld!.name=="viewerId") {
			let cnt = position.line - 2;
			while(cnt<position.line + 2) {
				let scld = FaugJsConfigStore.jsonFilesSymbolList[doc.uri.fsPath+"_linesinfo"][cnt++];
				if(scld && scld!.name=="schemaName") {
					const uripath = FaugJsConfigStore.schemaList[scld!.detail];
					if(FaugJsConfigStore.jsonFilesSymbolList[uripath]) {
						if(ld!.name=="op") {
							if(FaugJsConfigStore.jsonFilesSymbolList[uripath]["crud"][ld!.detail]) {
								return FaugJsConfigStore.jsonFilesSymbolList[uripath]["crud"][ld!.detail][""]["location"];
							} else {
								const uri = vscode.Uri.file(uripath);
								vscode.window.showInformationMessage("Crud operation "+ld.detail+" not found");
								return new vscode.Location(uri, new vscode.Position(0, 0));
							}
						} else {
							if(FaugJsConfigStore.jsonFilesSymbolList[uripath]["details"] && 
								FaugJsConfigStore.jsonFilesSymbolList[uripath]["details"]["viewer"]) {
									const viewer = FaugJsConfigStore.jsonFilesSymbolList[uripath]["details"]["viewer"];
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
			const uri = vscode.Uri.file(FaugJsConfigStore.schemaList[ld!.detail]);
			return new vscode.Location(uri, new vscode.Position(0, 0));
		}
	}
	return undefined;
}

async function parseSchemaFiles() {
	if(FaugJsConfigStore.schemaList) {
		for (const schname in FaugJsConfigStore.schemaList) {
			const uri = vscode.Uri.joinPath(FaugJsConfigStore.basePath, FaugJsConfigStore.schemaList[schname]);
			const symbols = await loadSymbolsForFile(uri, false);
			FaugJsConfigStore.parseJsonFile(uri, symbols);
		}
	}
}

class FaugJsConfigStore {
	public static jsonFilesSymbolList: Record<string, any> = {} as Record<string, any>;
	public static jsFilesFuncList: Record<string, any> = {} as Record<string, any>;
	public static schemaList: Record<string, string> = {} as Record<string, string>;
	public static moduleList: Array<string> = [] as Array<string>;
	public static configList: Array<string> = [] as Array<string>;
	public static templateList: Array<string> = [] as Array<string>;
	private static f_regex = /^([\t \}]*)(function)([\t ]*)([_A-Za-z0-9]+)([\t ]*\()/gm;
	public static waitFor = (delay: number) => new Promise(resolve => setTimeout(resolve, delay));
	public static basePath: vscode.Uri;

	public static isModule(uri: vscode.Uri) {
		if(uri.fsPath.endsWith("faug-min.js") || uri.fsPath.endsWith("faugn.js")) return true;
		for (const mod of FaugJsConfigStore.moduleList) {
			if(uri.fsPath.endsWith(mod)) {
				return true;
			}
		}
		return false;
	}

	public static isSchema(path: string) {
		for (const schname in FaugJsConfigStore.schemaList) {
			if(path.endsWith(FaugJsConfigStore.schemaList[schname])) {
				return true;
			}
		}
		return false;
	}

	public static isTemplate(path: string) {
		for (const tmplname of FaugJsConfigStore.templateList) {
			if(path.endsWith(tmplname)) {
				return true;
			}
		}
		return false;
	}

	public static findDefinition(doc: vscode.TextDocument, position: vscode.Position, override: boolean): vscode.Location | undefined {
		if(!override && !FaugJsConfigStore.isModule(doc.uri)) return undefined;
		const [word1, word2] = getWords(doc, position);
		return FaugJsConfigStore.resolvePossibleFunction(doc, word1, word2);
	}

	public static resolvePossibleFunction(doc: vscode.TextDocument, word1: string|undefined, word2: string): vscode.Location | undefined {
		for(const filename in FaugJsConfigStore.jsFilesFuncList) {
			if(!doc.uri.fsPath.endsWith(filename)) {
				if(word1 && FaugJsConfigStore.jsFilesFuncList[filename][word1] && FaugJsConfigStore.jsFilesFuncList[filename][word1][word2]) {
					return FaugJsConfigStore.jsFilesFuncList[filename][word1][word2][""]["location"];
				} else if(word2 && FaugJsConfigStore.jsFilesFuncList[filename][word2]) {
					return FaugJsConfigStore.jsFilesFuncList[filename][word2][""]["location"];
				}
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

	private static resolveClass(symbol: vscode.DocumentSymbol, lst: Record<string, any>) {
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

	private static resolveNewFunction(symbol: vscode.DocumentSymbol, lst: Record<string, any>) {
		for(const child of symbol.children) {
			if(child.kind === vscode.SymbolKind.Function) {
				FaugJsConfigStore.resolveFunction(child, lst);
			} else if(child.kind === vscode.SymbolKind.Variable) {
				lst[child.name] = {"": child};
			} else if(child.kind === vscode.SymbolKind.Property) {
				lst[child.name] = {"": child};
			} else if(child.kind === vscode.SymbolKind.Method) {
				lst[child.name] = {"": child};
			}
		}
	}

	private static resolveFunction(symbol: vscode.DocumentSymbol, lst: Record<string, any>) {
		lst[symbol.name] = {"": symbol};
		for(const child of symbol.children) {
			if(child.kind === vscode.SymbolKind.Function) {
				lst[symbol.name][child.name] = {"": child};
			}
		}
	}

	private static resolveVar(symbol: vscode.DocumentSymbol, lst: Record<string, any>) {
		if(symbol.kind === vscode.SymbolKind.Variable || symbol.kind === vscode.SymbolKind.Constant) {
			lst[symbol.name] = {"": symbol};
			for(const child of symbol.children) {
				if(child.kind === vscode.SymbolKind.Function && child.name === "<function>") {
					FaugJsConfigStore.resolveNewFunction(child, lst[symbol.name]);
				} else if(child.kind === vscode.SymbolKind.Function) {
					FaugJsConfigStore.resolveFunction(child, lst[symbol.name]);
				} else if(child.kind === vscode.SymbolKind.Property) {
					lst[symbol.name][child.name] = {"": child};
				}
			}
		}
	}

	private static resolveJsonPath(symbol: vscode.DocumentSymbol, lst: Record<string, any>, lstli: Array<any>) {
		lst[symbol.name] = {"": symbol};
		lstli[symbol.range.start.line] = symbol;
		for(const child of symbol.children) {
			FaugJsConfigStore.resolveJsonPath(child, lst[symbol.name], lstli);
		}
	}

	public static parseJsonFile(uri: vscode.Uri, symbols: vscode.DocumentSymbol[]) {
		if(symbols.length>0) {
			FaugJsConfigStore.jsonFilesSymbolList[uri.fsPath] = {};
			FaugJsConfigStore.jsonFilesSymbolList[uri.fsPath+"_linesinfo"] = {};
		}
		for(const symbol of symbols!) {
			FaugJsConfigStore.resolveJsonPath(symbol, FaugJsConfigStore.jsonFilesSymbolList[uri.fsPath], 
				FaugJsConfigStore.jsonFilesSymbolList[uri.fsPath+"_linesinfo"]);
		}
	}

	public static parseJsFile(uri: vscode.Uri, symbols: vscode.DocumentSymbol[] | undefined) {
		if(symbols!.length>0) FaugJsConfigStore.jsFilesFuncList[uri.fsPath] = {};
		//console.log("Parsing js module file => " + uri.fsPath);
		for(const symbol of symbols!) {
			try {
				if(symbol.name == "<unknown>") {
					continue;
				}
				if(symbol.kind === vscode.SymbolKind.Variable || symbol.kind === vscode.SymbolKind.Constant) {
					FaugJsConfigStore.resolveVar(symbol, FaugJsConfigStore.jsFilesFuncList[uri.fsPath]);
				} else if(symbol.kind === vscode.SymbolKind.Function) {
					if(symbol.name.endsWith(") callback")) continue;
					FaugJsConfigStore.resolveFunction(symbol, FaugJsConfigStore.jsFilesFuncList[uri.fsPath]);
				} else if(symbol.kind === vscode.SymbolKind.Class) {
					FaugJsConfigStore.resolveClass(symbol, FaugJsConfigStore.jsFilesFuncList[uri.fsPath]);
				}
			} catch (error) {
				console.error(error);
			}
		}
	}
}
