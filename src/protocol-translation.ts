/*
 * Copyright (C) 2017 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as path from 'path';
import * as lsp from 'vscode-languageserver';
import * as tsp from 'typescript/lib/protocol';
import URI from "vscode-uri";

export function isWindows(): boolean {
    return /^win/.test(process.platform);
}

export function uriToPath(stringUri: string): string {
    const uri = URI.parse(stringUri);
    return uri.fsPath;
}

export function pathToUri(p: string): string {
    return 'file://' + (isWindows() ? '/' + p.replace(/\//g, '/') : p);
}

export function toPosition(location: tsp.Location): lsp.Position {
    return {
        line: location.line - 1,
        character: location.offset - 1
    }
}

export function toLocation(fileSpan: tsp.FileSpan): lsp.Location {
    return {
        uri: pathToUri(fileSpan.file),
        range: {
            start: toPosition(fileSpan.start),
            end: toPosition(fileSpan.end)
        }
    };
}

export const completionKindsMapping: { [name: string]: lsp.CompletionItemKind } = {
    class: lsp.CompletionItemKind.Class,
    constructor: lsp.CompletionItemKind.Constructor,
    enum: lsp.CompletionItemKind.Enum,
    field: lsp.CompletionItemKind.Field,
    file: lsp.CompletionItemKind.File,
    function: lsp.CompletionItemKind.Function,
    interface: lsp.CompletionItemKind.Interface,
    keyword: lsp.CompletionItemKind.Keyword,
    method: lsp.CompletionItemKind.Method,
    module: lsp.CompletionItemKind.Module,
    property: lsp.CompletionItemKind.Property,
    reference: lsp.CompletionItemKind.Reference,
    snippet: lsp.CompletionItemKind.Snippet,
    text: lsp.CompletionItemKind.Text,
    unit: lsp.CompletionItemKind.Unit,
    value: lsp.CompletionItemKind.Value,
    variable: lsp.CompletionItemKind.Variable
};

const symbolKindsMapping: { [name: string]: lsp.SymbolKind } = {
    'enum member': lsp.SymbolKind.Constant,
    'JSX attribute': lsp.SymbolKind.Property,
    'local class': lsp.SymbolKind.Class,
    'local function': lsp.SymbolKind.Function,
    'local var': lsp.SymbolKind.Variable,
    'type parameter': lsp.SymbolKind.Variable,
    alias: lsp.SymbolKind.Variable,
    class: lsp.SymbolKind.Class,
    const: lsp.SymbolKind.Constant,
    constructor: lsp.SymbolKind.Constructor,
    enum: lsp.SymbolKind.Enum,
    field: lsp.SymbolKind.Field,
    file: lsp.SymbolKind.File,
    function: lsp.SymbolKind.Function,
    getter: lsp.SymbolKind.Method,
    interface: lsp.SymbolKind.Interface,
    let: lsp.SymbolKind.Variable,
    method: lsp.SymbolKind.Method,
    module: lsp.SymbolKind.Module,
    parameter: lsp.SymbolKind.Variable,
    property: lsp.SymbolKind.Property,
    setter: lsp.SymbolKind.Method,
    var: lsp.SymbolKind.Variable
};

export function toSymbolKind(tspKind: string): lsp.SymbolKind {
    return symbolKindsMapping[tspKind] || lsp.SymbolKind.Variable
}

export function toDiagnosticSeverity(category: string): lsp.DiagnosticSeverity {
    switch (category) {
        case 'error': return lsp.DiagnosticSeverity.Error
        case 'warning': return lsp.DiagnosticSeverity.Warning
        default: return lsp.DiagnosticSeverity.Information
    }
}

export function toDiagnostic(tspDiag: tsp.Diagnostic): lsp.Diagnostic {
    return {
        range: {
            start: toPosition(tspDiag.start),
            end: toPosition(tspDiag.end)
        },
        message: tspDiag.text,
        severity: toDiagnosticSeverity(tspDiag.category),
        code: tspDiag.code,
        source: 'typescript'
    }
}
