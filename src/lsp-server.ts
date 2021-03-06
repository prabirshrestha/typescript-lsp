/*
 * Copyright (C) 2017 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as lsp from 'vscode-languageserver';
import * as tsp from 'typescript/lib/protocol';
import { CommandTypes, EventTypes } from './tsp-command-types';

import { Logger, PrefixingLogger } from './logger';
import { TspClient } from './tsp-client';

import { LspClient } from './lsp-client';
import { DiagnosticEventQueue } from './diagnostic-queue';
import { uriToPath, toSymbolKind, toLocation, toPosition, completionKindsMapping, pathToUri } from './protocol-translation';

export interface IServerOptions {
    logger: Logger
    tsserverPath: string;
    tsserverLogFile?: string;
    lspClient: LspClient;
}

export class LspServer {

    private initializeParams: lsp.InitializeParams;
    private initializeResult: lsp.InitializeResult;
    private tspClient: TspClient;
    private openedDocumentUris: Map<string, number> = new Map<string, number>();
    private diagnosticQueue: DiagnosticEventQueue;
    private logger: Logger;

    constructor(private options: IServerOptions) {
        this.logger = new PrefixingLogger(options.logger, '[lspserver]')
        this.diagnosticQueue = new DiagnosticEventQueue(
            diagnostics => this.options.lspClient.publishDiagnostics(diagnostics),
            this.logger);
    }

    public initialize(params: lsp.InitializeParams): Promise<lsp.InitializeResult> {
        this.logger.log('initialize', params);

        // TODO: validate rootPath and rootUri

        this.initializeParams = params;

        this.tspClient = new TspClient({
            tsserverPath: this.options.tsserverPath,
            logFile: this.options.tsserverLogFile,
            logger: this.options.logger,
            onEvent: this.onTsEvent.bind(this)
        });

        this.tspClient.start();

        this.initializeResult = {
            capabilities: {
                textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
                completionProvider: {
                    triggerCharacters: ['.'],
                    resolveProvider: true
                },
                definitionProvider: true,
                documentSymbolProvider: true,
                hoverProvider: true,
                renameProvider: true,
                referencesProvider: true,
                workspaceSymbolProvider: true
            }
        };

        this.logger.log('onInitialize result', this.initializeResult);
        return Promise.resolve(this.initializeResult);
    }

    public requestDiagnostics(): Promise<tsp.RequestCompletedEvent> {
        const files: string[] = []
        // sort by least recently usage
        const orderedUris = [...this.openedDocumentUris.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
        for (const uri of orderedUris) {
            files.push(uriToPath(uri));
        }
        const args: tsp.GeterrRequestArgs = {
            delay: 0,
            files: files
        };
        return this.tspClient.request(CommandTypes.Geterr, args);
    }

    public didOpenTextDocument(params: lsp.DidOpenTextDocumentParams): void {
        const path = uriToPath(params.textDocument.uri);
        this.logger.log('onDidOpenTextDocument', params, path);
        this.tspClient.notify(CommandTypes.Open, {
            file: path,
            fileContent: params.textDocument.text
        });
        this.openedDocumentUris.set(params.textDocument.uri, new Date().getTime());
        this.requestDiagnostics();
    }

    public didCloseTextDocument(params: lsp.DidOpenTextDocumentParams): void {
        const path = uriToPath(params.textDocument.uri);
        this.logger.log('onDidCloseTextDocument', params, path);
        this.tspClient.notify(CommandTypes.Close, { file: path });
        this.openedDocumentUris.delete(params.textDocument.uri)
    }

    public didChangeTextDocument(params: lsp.DidChangeTextDocumentParams): void {
        const path = uriToPath(params.textDocument.uri)

        this.logger.log('onDidCloseTextDocument', params, path);
        this.openedDocumentUris.set(params.textDocument.uri, new Date().getTime());

        for (const change of params.contentChanges) {
            if (!change.range) {
                this.logger.error("Received non-incremental change for " + params.textDocument.uri);
                this.tspClient.notify(CommandTypes.Open, {
                    file: path,
                    fileContent: change.text
                });
            } else {
                this.tspClient.notify(CommandTypes.Change, {
                    file: path,
                    line: change.range.start.line + 1,
                    offset: change.range.start.character + 1,
                    endLine: change.range.end.line + 1,
                    endOffset: change.range.end.character + 1,
                    insertString: change.text
                });
            }
        }
        this.requestDiagnostics();
    }

    public didSaveTextDocument(params: lsp.DidChangeTextDocumentParams): void {
        // do nothing
    }

    public async definition(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('definition', params, path);

        const result = await this.tspClient.request(CommandTypes.Definition, {
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        return result.body ? result.body
            .map(fileSpan => toLocation(fileSpan)) : [];
    }

    public async documentSymbol(params: lsp.TextDocumentPositionParams): Promise<lsp.SymbolInformation[]> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('symbol', params, path);

        const response = await this.tspClient.request(CommandTypes.NavTree, {
            file: path
        });
        if (!response.body) {
            return [];
        }
        const result: lsp.SymbolInformation[] = [];
        const collectSymbol: (element: tsp.NavigationTree, parent: string|undefined, acceptor: (sym: lsp.SymbolInformation) => void ) => void =
            (element, parent, acceptor) => {
                const start = element.spans[0];
                const end = element.spans[element.spans.length - 1];
                if (start && end) {
                    const symbol = lsp.SymbolInformation.create(
                        element.text,
                        toSymbolKind(element.kind),
                        { start: toPosition(start.start), end: toPosition(end.end) },
                        params.textDocument.uri,
                        parent
                    );
                    acceptor(symbol);
                }
                if (element.childItems) {
                    for (const child of element.childItems) {
                        collectSymbol(child, element.text, acceptor);
                    }
                }
            };
        collectSymbol(response.body, undefined, sym => result.push(sym));
        return result;
    }

    public async completion(params: lsp.TextDocumentPositionParams): Promise<lsp.CompletionList> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('completion', params, path);

        const result = await this.tspClient.request(CommandTypes.Completions, {
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1,
            prefix: ''
        });
        return {
            isIncomplete: false,
            items: result.body ? result.body
                .map(item => {
                    return <lsp.CompletionItem>{
                        label: item.name,
                        kind: completionKindsMapping[item.kind],
                        // store information for resolve
                        data: {
                            file: path,
                            line: params.position.line + 1,
                            offset: params.position.character + 1
                        }
                    };
                }) : []
        };
    }

    public async completionResolve(item: lsp.CompletionItem): Promise<lsp.CompletionItem> {
        this.logger.log('completion/resolve', item);
        const result = await this.tspClient.request(CommandTypes.CompletionDetails, <tsp.CompletionDetailsRequestArgs>{
            entryNames: [item.label],
            file: item.data.file as string,
            line: item.data.line as number,
            offset: item.data.offset as number,
        })
        if (!result.body) {
            return item
        }
        item.documentation = result.body[0].documentation.map( i => i.text).join('\n');
        return item;
    }

    public async hover(params: lsp.TextDocumentPositionParams): Promise<lsp.Hover> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('hover', params, path);

        const result = await this.tspClient.request(CommandTypes.Quickinfo, {
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        if (!result.body) {
            return <lsp.Hover>{
                contents: []
            }
        }
        const range = {
            start: toPosition(result.body.start),
            end: toPosition(result.body.end)
        };
        const contents: lsp.MarkedString[] = [
            { language: 'typescript', value: result.body.displayString }
        ];
        if (result.body.documentation) {
            contents.push(result.body.documentation)
        }
        return {
            contents,
            range
        }
    }

    public async rename(params: lsp.RenameParams): Promise<lsp.WorkspaceEdit> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('onRename', params, path);

        const result = await this.tspClient.request(CommandTypes.Rename, {
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });

        const workspaceEdit = {
            changes: {}
        };

        if (!result.body || !result.body.info.canRename || result.body.locs.length === 0) {
            return workspaceEdit;
        }
        result.body.locs
            .forEach((spanGroup) => {
                const uri = pathToUri(spanGroup.file),
                    textEdits = workspaceEdit.changes[uri] || (workspaceEdit.changes[uri] = []);

                spanGroup.locs.forEach((textSpan) => {
                    textEdits.push({
                        newText: params.newName,
                        range: {
                            start: toPosition(textSpan.start),
                            end: toPosition(textSpan.end)
                        }
                    });
                });
            });

        return workspaceEdit;
    }

    public async references(params: lsp.TextDocumentPositionParams): Promise<lsp.Location[]> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('onReferences', params, path);

        const result = await this.tspClient.request(CommandTypes.References, {
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        if (!result.body) {
            return [];
        }
        return result.body.refs
            .map(fileSpan => toLocation(fileSpan));
    }

    private lastFileOrDummy(): string {
        for (const uri of this.openedDocumentUris.keys()) {
            return uriToPath(uri);
        }
        return this.initializeParams.rootUri ? uriToPath(this.initializeParams.rootUri) : this.initializeParams.rootPath!;
    }

    public async workspaceSymbol(params: lsp.WorkspaceSymbolParams): Promise<lsp.SymbolInformation[]> {
        const result = await this.tspClient.request(CommandTypes.Navto, {
            file: this.lastFileOrDummy(),
            searchValue: params.query
        });
        if (!result.body) {
            return []
        }
        return result.body.map(item => {
            return <lsp.SymbolInformation>{
                location: {
                    uri: pathToUri(item.file),
                    range: {
                        start: toPosition(item.start),
                        end: toPosition(item.end)
                    }
                },
                kind: toSymbolKind(item.kind),
                name: item.name
            };
        });
    }

    protected onTsEvent(event: protocol.Event): void {
        if (event.event === EventTypes.SementicDiag) {
            this.diagnosticQueue.addSemanticDiagnostic(event);
        } else if (event.event === EventTypes.SyntaxDiag) {
            this.diagnosticQueue.addSyntacticDiagnostic(event);
        } else {
            this.logger.log("Ignored event : " + event.type, event);
        }
    }
}
