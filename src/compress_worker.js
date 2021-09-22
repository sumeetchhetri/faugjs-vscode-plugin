const fs = require('fs');
const esprima = require('esprima');
const csso = require('csso');
const xpath = require('xpath'), dom = require('xmldom').DOMParser;
const path = require('path');
const parseJson = require('parse-json');
const minify = require('@node-minify/core');
const gcc = require('@node-minify/google-closure-compiler');
const uglifyjs = require('@node-minify/terser');
const sqwish = require('@node-minify/sqwish');
const noCompress = require('@node-minify/no-compress');
const {parentPort} = require("worker_threads");

parentPort.on("message", data => {
	//log("child:" + JSON.stringify(data));
	compressAll(data.dirPath, (by)=> {
		parentPort.postMessage({type: 1, status: 'progress', by: by});
	});
	parentPort.postMessage({type: 1, status: 'done'});
});

function log(msg) {
	parentPort.postMessage({type: 2, stype: 'INFO', message: msg});
}

function error(msg) {
	if(msg.stack) {
		parentPort.postMessage({type: 2, stype: 'ERROR', message: msg.stack});
	} else {
		parentPort.postMessage({type: 2, stype: 'ERROR', message: msg});
	}
}

function jsonParse(json, err2print, numerrs) {
    try {
        return JSON.parse(json);
    } catch (e) {
		try {
            parseJson(json);
        } catch (e) {
            error(err2print);
            error(e);
            numerrs[0] = numerrs[0] + 1;
        }
		//error(e);
        //numerrs[0] = numerrs[0] + 1;
    }
}

function getEssentials(dirPath, module) {
    let rawHtml = fs.readFileSync(dirPath + path.sep + 'index.html', 'utf8');
    
    let numerrs = [0];
    let configFileName = 'fjs-config.json';
    log("module name ---->" + module);
    if(module != "") {
    	configFileName = 'fjs-config_'+module+'.json';
    }
    let config = jsonParse(fs.readFileSync(dirPath + path.sep + configFileName, 'utf8'), "Error parsing fjs-config.json, invalid json", numerrs);
    if(numerrs[0]>0) {
        throw "Unable to read fjs-config.json"
    }
    return [rawHtml, config];
}

function compressSchemas(config, fileName, type, dirPath, sc) {
    let schemas = {};
    let numerrs = [0];
    if((type==1 || type==3) && fileName) {
        let context = "XXXXX Error parsing schema schemas/" + fileName;
        let data = jsonParse(fs.readFileSync(dirPath + path.sep + "schemas" + path.sep + fileName, 'utf8'), context, numerrs);
        schemas["schemas/" + fileName] = data;
        sc[0] = sc[0] + 1;
    } else if (is('Array', config.schemas)) {
        for (let i = 0; i < config.schemas.length; i++) {
            let context = "XXXXX Error parsing schema " + config.schemas[i][0];
            let data = jsonParse(fs.readFileSync(dirPath + path.sep + config.schemas[i][0], 'utf8'), context, numerrs);
            schemas[config.schemas[i][0]] = data;
            sc[0] = sc[0] + 1;
        }
    } else {
        for ( let k in config.schemas) {
            if (config.schemas.hasOwnProperty(k)) {
                context = "XXXXX Error parsing schema " + config.schemas[k][0];
                let data = jsonParse(fs.readFileSync(dirPath + path.sep + config.schemas[k][0], 'utf8'), context, numerrs);
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

let currtemcode, temerror = 0;
function faugX(dirPath, htmlTemplates, tname, options, flag, istmfromopts, isValidate) {
	flag = isN(flag) ? false : flag;
	let data = fs.readFileSync(dirPath + path.sep + tname, 'utf8');
	if (flag) {
		htmlTemplates[tname] = [data];
	} else {
		try {
			let fb = te(data, options, true, istmfromopts);
			if (is('String', fb)) {
				temerror = -1;
				if(isValidate) {
					return [-1, "XXXXX Error compiling template " + tname, undefined, currtemcode];
				}
				error("XXXXX Error compiling template " + tname);
				error(fb);
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
			error("XXXXX Exception compiling template " + tname);
			error(err);
			error(currtemcode);
		}
	}
}

function te(html, options, retFunc, isVarFromOptions, escH) {
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
	var mulre = /##([\s\S]*?)##/g;
	var incre = /!!([a-zA-Z0-9_\-\.\s\/()]+)!!/g;
	var varnamere = /^[^a-zA-Z_$]|[^\\w$]/;

	var nhtml = '';
	while (match = mulre.exec(html)) {
		nhtml += html.slice(cursor, match.index);
		var htmlines = match[1].split("\n");
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

	var add = function(line, js) {
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
						isjsvarflag &= true;
						jsvartl = 'arg["' + dotnt[0] + '"]';
					} else if (js && isVarFromOptions && varnamere.test(dotnt[k])) {
						isjsvarflag &= true;
						jsvartl += "." + dotnt[k];
					} else {
						isjsvarflag &= false;
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
					line = js ? tl : ('"' + tl.replace(/"/g, '\\"') + '"');
					code += isvar ? (line + '\n') : ('____r_____.push(' + line + ');\n');
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
			add(htm.slice(cursor, match.index))(match[1], true);
			cursor = match.index + match[0].length;
		}
		add(htm.substr(cursor, htm.length - cursor));
	}

	var addf = function(line, js) {
		if (line != '') {
			if (js || incre.test(line)) {
				code += line + '\n';
			} else {
				if (line.indexOf('____r_____.push(') == 0) {
					code += line + "\n";
				} else {
					code += '____r_____.push("' + line.replace(/"/g, '\\"') + '");\n';
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

	var addI = function(line, ismatch) {
		if (line != "") {
			if (ismatch) {
				line = line.trim();
				var cmps = line.split(" ");
				code += "var _exttargs = {};\n";
				line = cmps[0];
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
				code += ('____r_____.push(Faug.includeTemplate(\"' + line.trim() + '\", _exttargs));\n');
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
			addI(htm.slice(cursor, match.index))(match[1], true);
			cursor = match.index + match[0].length;
		}
		addI(htm.substr(cursor, htm.length - cursor));
	}

	code = fcode + code + 'return ____r_____.join("");\n';
	code = code.replace(/[\r\n]/g, '');
	currtemcode = code;
	if (retFunc) {
		return Function.apply(null, ["arg", code]);
	} else {
		return Function.apply(null, ["arg", code]).apply(null, [options]);
	}
}

function compressTemplates(config, fileName, type, schemas, dirPath, tc, lazyValidation, htmlTemplates) {
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
    
    let uniqtmpl = {};
    for (let i = 0; i < templates.length; i++) {
        let type = templates[i][1];
        let tname = templates[i][0];
        let tmplvars = templates[i].length == 3 ? templates[i][2] : null;
        if (type == 0) {
            if (!uniqtmpl[tname]) {
                if(!lazyValidation) {
					faugX(dirPath, htmlTemplates, tname, {rows: null, options: null});
                	uniqtmpl[tname] = 0;
				} else {
					htmlTemplates[tname] = [0];
				}
                tc[0] = tc[0] + 1;
            }
        } else if (type == 1 || type == 2) {
            if (!uniqtmpl[tname]) {
                if(!lazyValidation) {
					faugX(dirPath, htmlTemplates, tname, {isTransient: null, elName: null, rows: null, selectedVal: null, details: null, vars: null, options: null});
                	uniqtmpl[tname] = 2;
				} else {
					htmlTemplates[tname] = [2];
				}
                tc[0] = tc[0] + 1;
            }
        } else if (type == 3 || type == 5) {
            if (!uniqtmpl[tname]) {
                if(!lazyValidation) {
					faugX(dirPath, htmlTemplates, tname, tmplvars);
                	uniqtmpl[tname] = 5;
				} else {
					htmlTemplates[tname] = [5, tmplvars];
				}
                tc[0] = tc[0] + 1;
            }
        } else if (type == 4) {
            if (!uniqtmpl[tname]) {
                if(!lazyValidation) {
					faugX(dirPath, htmlTemplates, tname, tmplvars, false, true);
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

function isN(val) {
    return val === undefined || val == null || val === '';
}

function is(type, obj) {
    let clas = Object.prototype.toString.call(obj).slice(8, -1);
    return obj !== undefined && obj !== null && clas === type;
}

function addNestedTemplates(schema, data, templates, fileName) {
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

const waitFor = (delay) => new Promise(resolve => setTimeout(resolve, delay));
function compressJsCss(rawHtml, config, dirPath, schemas, htmlTemplates, module) {
    let doc = new dom({
        errorHandler:{warning:function(w){},error: function(e){error(e);throw e;},fatalError: function(e){error(e);throw e;}}
    }).parseFromString(rawHtml);
    function getNodes(xp) {
        return xpath.select(xp, doc);
    }
    let cssFiles = [[], []];
    let jsFileObjArr = [];
    let tags = getNodes("/html/head/link");
    for (let t = 0; t < tags.length; t++) {
        for (let i = 0; i < tags[t].attributes.length; i++) {
            if(tags[t].attributes[i].name.toLowerCase()=="href" && tags[t].attributes[i].value) {
                let href = tags[t].attributes[i].value;
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
                var jsFileObj = {};
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
    
    function validateJsFiles(jsFileObjArr, cssFiles, config, dirPath) {
    	var jsFileObj = {};
    	jsFileObj["name"] = dirPath + path.sep + "resources/bootstrap.min.js";
    	jsFileObj["isMin"] = true;
    	jsFileObjArr.splice(1, 0, jsFileObj);
    	
    	var jsFileObj = {};
    	jsFileObj["name"] = dirPath + path.sep + "resources/bootbox.min.js";
    	jsFileObj["isMin"] = true;
    	jsFileObjArr.push(jsFileObj);
    	
        let deps = [["resources/javascript-xpath-latest-cmp.js"], ["resources/json2.js"], ["resources/jquery.dataTables.js"], ["resources/dataTables.bootstrap.js"],["faug-ext-globalize.js"]];
        for (let i = 0; i < deps.length; i++) {
        	var jsFileObj = {};
        	jsFileObj["name"] = dirPath + path.sep + deps[i][0];
			jsFileObj["mname"] = dirPath + path.sep + "out" + path.sep + deps[i][0];
        	jsFileObj["isMin"] = false;
        	jsFileObjArr.push(jsFileObj);
        }
        deps = ["resources/cldr/cldr.js", "resources/cldr/event.js", "resources/cldr/supplemental.js", "resources/globalize/globalize.js", "resources/globalize/number.js", "resources/globalize/plural.js", "resources/globalize/currency.js", "resources/globalize/date.js", "resources/globalize/message.js", "resources/globalize/relative-time.js", "resources/globalize/unit.js", "resources/jquery.datetimepicker.js", "resources/diffDOM.js"];
        for (let i = 0; i < deps.length; i++) {
            var jsFileObj = {};
        	jsFileObj["name"] = dirPath + path.sep + deps[i];
			jsFileObj["mname"] = dirPath + path.sep + "out" + path.sep + deps[i];
        	jsFileObj["isMin"] = false;
        	jsFileObjArr.push(jsFileObj);
        }
        for (let i = 0; i < config.modules.length; i++) {
        	var jsFileObj = {};
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

         // log(JSON.stringify(jsfilesAll));
        // log(JSON.stringify(jsFiles));

        log("Total number of js files = " + jsFileObjArr.length);
        log("Total number of css files = " + (cssFiles[0].length + cssFiles[1].length));

        let flag = 0;
        let allcssfiles = [].concat(cssFiles[0]).concat(cssFiles[1]);
        for (let i = 0; i < allcssfiles.length; i++) {
            //log(allcssfiles[i]);
            let c = fs.readFileSync(allcssfiles[i], 'utf8');
            try {
                let ast = csso.syntax.parse(c);
            } catch (err) {
                flag = 2;
                error("XXXXX Got (" + err + ") while parsing " + allcssfiles[i]);
            }
        }

        if (flag == 2) { 
            throw "XXXXX Error parsing file syntax errors found"; 
        }

        let jst = [];
        flag = 0;
        for (let i = 0; i < jsfilesAll.length; i++) {
            //log(jsfilesAll[i]);
            let c = fs.readFileSync(jsfilesAll[i], 'utf8');
            try {
                let tree = esprima.parse(c);

                let fmap = {};
                for (let j = 0; j < tree.body.length; j++) {
                    if (tree.body[j].type == 'FunctionDeclaration') {
                        let fkk = tree.body[j].id.name + "(" + tree.body[j].params.length + ")";
                        if (fmap[fkk]) {
                            flag = 1;
                            error("XXXXX Duplicate FunctionDeclaration function " + fkk + " in file " + jsfilesAll[i])
                        } else {
                            fmap[fkk] = true;
                        }
                    }
                }
            } catch (e) {
                if((e+"").indexOf("XXXXX Error:")!=-1) {
                    error((e + "").replace("XXXXX Error:", "Error in file " + jsfilesAll[i] + ":"));
                } else {
                    if((e+"").indexOf("\n")!=-1) {
                        error("Error in file " + jsfilesAll[i] + ": " + (e+"").split("\n")[0]);
                    } else {
                        error("Error in file " + jsfilesAll[i] + ": ");
                        error(e);
                    }
                }
                // error("***Syntax errors found in file " + jsfilesAll[i] +
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
                            error("Problem compacting js file " + config.modules[ind]);
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

const processMinify = async(jsFileObjArr, cssFiles, config, dirPath) => {
	// Using Google Closure Compiler
	let jsFileComp = [];
	let tempFiles = [];
	for(let k=0; k<jsFileObjArr.length; k++) {
		if(jsFileObjArr[k]["isMin"] == false) {
			let tempFileName = jsFileObjArr[k]["mname"].replace(".js", ".min.js");
			jsFileComp.push(tempFileName);
			tempFiles.push(tempFileName);
			log(tempFileName);
			await minify({compressor: uglifyjs, input: jsFileObjArr[k]["name"], output: tempFileName, options: {warnings: false, mangle: false, compress: false}});
		} else {
			jsFileComp.push(jsFileObjArr[k]["name"]);
		}
	}

	try {
		cntxt = 2;
		await minify({compressor: noCompress, input: jsFileComp, output: dirPath + path.sep + "out" + path.sep + 'main.js'});
		log("Compaction of js files successfull");
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
		log("Compression of css files successfull");
		//compressConfig();
	} catch (err) {
		let e;
		if(cntxt==1)e = ("Compression of js files failed with error " + err);
		else if(cntxt==2)e = ("Compaction of js files failed with error " + err);
		else if(cntxt==3)e = ("Compression of js files failed with error " + err);
		else e = ("Compaction of css files failed with error " + err);
		error(e);
		throw e;
	}
	
	/*}).catch(function(err) {
		let e;
		if(cntxt==1)e = ("Compression of js files failed with error " + err);
		else if(cntxt==2)e = ("Compaction of js files failed with error " + err);
		else if(cntxt==3)e = ("Compression of js files failed with error " + err);
		else e = ("Compaction of css files failed with error " + err);
		error(e);
		throw e;
	});*/
}

function compress(dirPath, module, fileName, type, cb, lazyValidation, htmlTemplates) {
    let t = getEssentials(dirPath, module);
    let rawHtml= t[0];
    let config= t[1];
    
    function readTiuXmlMapping(filename, tiuschs, tiutmps) {
        let numerrs = [0];
        let tmpdata = JSON.parse(fs.readFileSync(dirPath + path.sep + filename, 'utf8'), "Error parsing "+filename+", invalid json", numerrs);
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
    
	function compressConfig(config, fileName, schemas, htmlTemplates, type, module) {
        let sc = false, tc = false, msg;
        let tiuschs = [], tiutmps = [];
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
            log("Found only "+tiuschs.length+ " usable tiuxmls, will compress only these");
        }
        
        if(Object.keys(schemas).length>0) {
            if(tiuschs.length>0) {
                let dschemas = {};
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
                    log("Updated total number of schemas to be compressed = " + fl);
                    schemas = dschemas;
                }
            }
            if(fileName) {
                log("Changed/New schema file is " + fileName);
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
                log("Generating compressed schema file for all schemas");
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
                let dhtmlTemplates = {};
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
                    log("Updated total number of templates to be compressed = " + fl);
                    htmlTemplates = dhtmlTemplates;
                }
            }
            if(fileName) {
                log("Changed/New template file is " + fileName);
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
                log("Generating compressed template file for all templates");
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
        log("Total number of schemas to be compressed = " + sc[0]);
    }
    
    if(type==3) {
        fileName = fileName.substring(0, fileName.lastIndexOf(".")) + ".html"
    }
    
    if(type!=1) {
    	tc = [0];
    	compressTemplates(config, fileName, type, schemas, dirPath, tc, lazyValidation, htmlTemplates);
    	log("Total number of templates to be compressed = " + tc[0]);
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

function compressAll(dirPath, progressFunc) {
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
	const mods = [];
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

function gatherTemplates(dirPath, htmlTemplates) {
	compress(dirPath, "", undefined, 5, undefined, true, htmlTemplates);
	if (fs.existsSync(dirPath+path.sep+"modules")) {
		fs.readdirSync(dirPath+path.sep+"modules").forEach(module => {
			if(fs.lstatSync(dirPath+path.sep+"modules"+path.sep+module).isDirectory()) {
				compress(dirPath, module, undefined, 5, undefined, true, htmlTemplates);
			}
		});
	}
}
