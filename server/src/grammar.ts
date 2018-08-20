import { TextDocument, Position, TextDocumentItem, LogMessageNotification, CompletionItem, Diagnostic, Range } from "vscode-languageserver";
import linq from "linq";
//import sourceShaderLab from "./shaderlab.grammar";

type DocumentCompletionCallback = () => CompletionItem[];
type DocumentDiagnoseCallback = (text: string, range: Range) => Diagnostic[];
type PatternItemDictionary = { [key: string]: (pattern: GrammarPattern) => PatternItem };

class Code
{
    scopes: Scope;
}
class Scope
{
    document: TextDocument;
    startOffset: number = 0;
    endOffset: number = 0;
    scopes: Scope[] = [];
    scopeDeclare: ScopeDeclare;
    constructor(doc: TextDocument, declare: ScopeDeclare)
    {
        this.scopeDeclare = declare;
        this.document = doc;
    }
    get startPosition() { return this.document.positionAt(this.startOffset); }
    get endPosition() { return this.document.positionAt(this.endOffset); }
    get text() { return this.document.getText({ start: this.startPosition, end: this.endPosition }); }
}
class ShaderCode implements Code
{
    scopes: Scope;
    constructor(doc: TextDocument)
    {
        //this.scopes = scopeMatch(sourceShaderLab, doc, 0);
    }
}
class ScopeDeclare
{
    name?: string;
    begin?: RegExp;
    end?: RegExp;
    scopes?: ScopeDeclare[];
    _matchbegin?: RegExpMatchArray;
    _matchEnd?: RegExpExecArray;
    patterns?: PatternDeclare[] = [];
}
class MatchCapturePattern
{
    name?: string;
    match?: RegExp;
    default?: boolean = false;
    captures?: MatchCaptures = new MatchCaptures();
    onCompletion?: DocumentCompletionCallback;
}
class MatchCaptures
{
    [key: string]: PatternDeclare;
}
class PatternDeclare
{
    name?: string;
    match?: RegExp;
    default?: boolean = false;
    //patterns?: PatternDeclare[] = [];
    captures?: MatchCaptures = new MatchCaptures();
    onCompletion?: DocumentCompletionCallback;
    diagnostic?: Diagnostic;
    unmatched?: Diagnostic;
}
function matchInRange(reg: RegExp, doc: TextDocument, start: number, end: number): RegExpExecArray
{
    let subDoc = doc.getText({ start: doc.positionAt(start), end: doc.positionAt(end) });
    return reg.exec(subDoc);
}
function scopeMatch(scopeDeclare: ScopeDeclare, doc: TextDocument, startOffset: number = 0, endOffset: number = doc.getText().length - 1): Scope
{
    let nextStartOffset = startOffset;
    let match: RegExpExecArray = null;
    if (scopeDeclare.begin)
    {
        let subDoc = doc.getText({ start: doc.positionAt(startOffset), end: doc.positionAt(endOffset) });
        match = scopeDeclare.begin.exec(subDoc);
        if (scopeDeclare.begin && !match)
            return;
        if (match)
        {
            nextStartOffset = startOffset + match.index + match[0].length;
        }
    }
    let scope = new Scope(doc, scopeDeclare);
    if (match)
        scope.startOffset = startOffset + match.index;

    let hasSubScope = false;
    do
    {
        hasSubScope = false;

        // To get the headmost sub-scope
        let subScopeList = linq.from(scopeDeclare.scopes)
            .orderBy(scope =>
            {
                scope._matchbegin = matchInRange(scope.begin, doc, nextStartOffset, endOffset);
                if (scope._matchbegin)
                    return scope._matchbegin.index;
                return Number.MAX_SAFE_INTEGER;
            }).toArray();

        // Check if sub-scope is out of current scope
        let endMatch = null;
        if (scopeDeclare.end)
        {
            endMatch = matchInRange(scopeDeclare.end, doc, nextStartOffset, endOffset);
            if (!endMatch)
                return null;
        }

        for (let i = 0; i < subScopeList.length; i++)
        {
            // Remove the sub-scope which is out of current scope
            if (!subScopeList[i]._matchbegin)
                continue;
            if (endMatch && endMatch.index <= subScopeList[i]._matchbegin.index)
                break;

            let subScope = scopeMatch(subScopeList[i], doc, nextStartOffset, endOffset);
            if (subScope)
            {
                scope.scopes.push(subScope);
                nextStartOffset = subScope.endOffset + 1;
                hasSubScope = true;
                break;
            }
        }
    }
    while (hasSubScope);

    if (!scopeDeclare.end)
    {
        scope.endOffset = endOffset;
    }
    else
    {
        match = matchInRange(scopeDeclare.end, doc, nextStartOffset, endOffset);
        if (!match)
            return null;
        endOffset = nextStartOffset + match.index + match[0].length;
        scope.endOffset = endOffset;
    }
    return scope;

}

function diagnostic(pattern: PatternDeclare, doc: TextDocument, startOffset: number, endOffset: number): Diagnostic[]
{
    let diagnostics: Diagnostic[] = [];
    if (pattern.match)
    {
        let match = matchInRange(pattern.match, doc, startOffset, endOffset);
        if (pattern.captures)
        {
            for (let i = 0; i < match.length; i++)
            {
                if (!pattern.captures[i])
                    continue;

                // Handle unmatch diagnostic
                if (match[i] === undefined && pattern.captures[i].unmatched)
                {
                    let diag = pattern.captures[i].unmatched;
                    diag.range = { start: doc.positionAt(startOffset + match.index), end: doc.positionAt(startOffset + match.index + match[0].length) };
                    diagnostics.push(diag);
                }


            }
        }
    }
    return diagnostics;
}

enum MatchResult
{
    NotMatched = 0,
    Matched = 1,
    Skip = 2,
}
abstract class PatternItem
{
    name: string = "pattern";
    parent?: NestedPattern;
    ignorable: boolean = false;
    multi: boolean = false;
    pattern: GrammarPattern;
    abstract match(doc: TextDocument, startOffset: number): GrammarMatch;
    constructor(pattern: GrammarPattern, ignorable = false)
    {
        this.pattern = pattern;
        this.ignorable = ignorable;
    }
    toString():string
    {
        return this.ignorable ? `[${this.name}]` : `<${this.name}>`;
    }
}

class EmptyPattern extends PatternItem
{
    name = "space";
    constructor(pattern: GrammarPattern, ignorable: boolean = false)
    {
        super(pattern, ignorable);
    }
    static skipEmpty(doc: TextDocument, startOffset: number, crossLine = false): RegExpExecArray
    {
        const reg = crossLine ?
            /((?:\s|\/\*(?!\/).*?\*\/)*)(\/\/.*[\r]?[\n]?)?/
            :
            /((?:[ \t]|\/\*(?!\/).*?\*\/)*)?/;
        const text = doc.getText().substr(startOffset);
        let match = reg.exec(text);
        if (match.index > 0)
            return null;
        return match;
    }
    match(doc: TextDocument, startOffset: number): GrammarMatch
    {
        let empty = EmptyPattern.skipEmpty(doc, startOffset, this.pattern.crossLine);
        let match = new GrammarMatch(doc, this);
        match.startOffset = startOffset;
        if (empty && empty[0].length > 0)
        {
            match.endOffset = startOffset + empty[0].length;
            match.matched = true;
        }
        else
        {
            match.endOffset = startOffset;
            match.matched = false;
        }
        return match;
    }
}
class RegExpPattern extends PatternItem
{
    name = "regExp";
    regExp: RegExp;
    constructor(pattern: GrammarPattern, reg: RegExp, ignorable: boolean = false)
    {
        super(pattern, ignorable);
        this.regExp = reg;
    }
    match(doc: TextDocument, startOffset: number): GrammarMatch
    {
        let skip = EmptyPattern.skipEmpty(doc, startOffset, this.pattern.crossLine);
        if (skip)
            startOffset += skip[0].length;
        let text = doc.getText().substr(startOffset);
        let regMatch = this.regExp.exec(text);
        let match = new GrammarMatch(doc, this);
        match.startOffset = startOffset;
        if (!regMatch || regMatch.index !== 0)
        {
            match.endOffset = startOffset;
            match.matched = false;
        }
        else
        {
            match.endOffset = startOffset + regMatch[0].length;
            match.matched = true;
        }
        return match;
    }
}
class TextPattern extends RegExpPattern
{
    text: string;
    currentIdx: number = 0;
    get ignoreCase() { return this.regExp.ignoreCase; }
    constructor(pattern: GrammarPattern, text: string, ignorable = false, ignoreCase = false)
    {
        super(pattern, new RegExp(text.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'), ignoreCase ? "i" : ""), ignorable);
        this.text = text;
        this.name = text;
    }
}
class StringPattern extends RegExpPattern
{
    name = "string";
    begin: boolean = false;
    slash: boolean = false;
    end: boolean = false;
    constructor(pattern: GrammarPattern, ignorable = false)
    {
        super(pattern, /"([^\\"]|\\\S|\\")*"/, ignorable);
    }
    toString = () => this.ignorable ? "[string]" : "<string>";
}
class NumberPattern extends RegExpPattern
{
    name = "number";
    constructor(pattern: GrammarPattern, ignorable = false)
    {
        super(pattern, /[+-]?[0-9]+\.?[0-9]*/, ignorable);
    }
}
class IdentifierPattern extends RegExpPattern
{
    name = "identifier";
    constructor(pattern: GrammarPattern, ignorable = false)
    {
        super(pattern, /[_a-zA-Z][_a-zA-Z0-9]*/, ignorable);
    }
}

class NestedPattern extends PatternItem
{
    name = "nest";
    subPatterns: PatternItem[] = [];
    currentIdx: number = 0;
    get count() { return this.subPatterns.length; }
    addSubPattern(patternItem: PatternItem)
    {
        this.subPatterns.push(patternItem);
    }
    toString()
    {
        let str = super.toString() + "\r\n" + this.subPatterns.map(pattern => pattern.toString()).join("\r\n").split(/\r\n/g).map(str => "\t" + str).join("\r\n");
        return str;
    }
    match(doc: TextDocument, startOffset: number): GrammarMatch
    {
        let match = new GrammarMatch(doc, this);
        match.startOffset = startOffset;
        try 
        {
            for (let i = 0; i < this.subPatterns.length; i++)
            {
                let subMatch = this.subPatterns[i].match(doc, startOffset);
                if (!subMatch.matched)
                {
                    if (this.subPatterns[i].ignorable)
                        continue;
                    match.children.push(subMatch);
                    match.endOffset = subMatch.endOffset;
                    match.matched = false;
                    return match;
                }
                match.children.push(subMatch);
                startOffset = subMatch.endOffset;
                if (this.subPatterns[i].multi)
                    i--;
            }
            if (match.children.length === 0)
            {
                match.endOffset = match.startOffset + 1;
                match.matched = false;
            }
            else
            {
                match.endOffset = match.children[match.children.length - 1].endOffset;
                match.startOffset = match.children[0].startOffset;
                match.matched = true;
            }
        }
        catch (ex)
        {
            console.error(ex);
        }
        return match;
    }
}
class OptionalPatterns extends NestedPattern
{
    name = "optional";

    match(doc: TextDocument, startOffset: number): GrammarMatch
    {
        let match = new GrammarMatch(doc, this);
        match.startOffset = startOffset;
        for (let i = 0; i < this.subPatterns.length; i++)
        {
            let subMatch = this.subPatterns[i].match(doc, startOffset);
            if (!subMatch.matched)
                continue;
            match.children.push(subMatch);
            break;
        }
        if (match.children.length === 0)
        {
            match.endOffset = match.startOffset + 1;
            match.matched = false;
        }
        else
        {
            match.endOffset = match.children[match.children.length - 1].endOffset;
            match.startOffset = match.children[0].startOffset;
            match.matched = true;
        }
        return match;
    }
}
class PatternScope extends NestedPattern
{
    name = "scope";
    scope: GrammarScope;

    constructor(pattern: GrammarPattern, scope: GrammarScope)
    {
        super(pattern, false);
        this.scope = scope;
    }
    match(doc: TextDocument, startOffset: number): GrammarMatch
    {
        function cleanSpace()
        {
            let skip = EmptyPattern.skipEmpty(doc, startOffset, true);
            if (skip)
                startOffset += skip[0].length;
        }
        let match = new GrammarMatch(doc, this);
        match.startOffset = startOffset;
        try 
        {
            // Match first pattern
            let subMatch = this.subPatterns[0].match(doc, startOffset);
            match.children.push(subMatch);
            match.endOffset = startOffset = subMatch.endOffset;
            if (!subMatch.matched)
            {
                match.matched = false;
                return match;
            }
            else
                cleanSpace();
            
            let hasMatched = false;
            for (let i = 1; i < this.subPatterns.length; i++)
            {
                let subMatch = this.subPatterns[i].match(doc, startOffset);
                if (!subMatch.matched)
                {
                    if (i < this.subPatterns.length - 1)
                        continue;
                }
                else
                {
                    match.children.push(subMatch);
                    match.endOffset = startOffset = subMatch.endOffset;
                    hasMatched = true;
                    if (i === this.subPatterns.length - 1)
                        break;

                    cleanSpace();
                }

                // Skip a line and continue matching
                if (!hasMatched)
                {
                    let unMatched = new UnMatchedText(doc, this.scope);
                    unMatched.startOffset = startOffset;
                    match.children.push(unMatched);

                    let pos = doc.positionAt(startOffset);
                    pos.line++;
                    pos.character = 0;
                    startOffset = doc.offsetAt(pos);
                    unMatched.endOffset = startOffset - 1;
                    // Chceck if reach end
                    let pos2 = doc.positionAt(startOffset);
                    if (pos2.line !== pos.line)
                    {
                        match.matched = false;
                        return match;
                    }
                    cleanSpace();
                }
                i = 0;
                hasMatched = false;
            }
                
            if (match.children.length === 0)
            {
                match.endOffset = match.startOffset + 1;
                match.matched = false;
            }
            else
            {
                match.endOffset = match.children[match.children.length - 1].endOffset;
                match.startOffset = match.children[0].startOffset;
                match.matched = true;
            }
        }
        catch (ex)
        {
            console.error(ex);
        }
        return match;
    }
}
class Grammar extends NestedPattern
{
    name = "grammar";
    grammar: GrammarDeclare;
    constructor(grammar: GrammarDeclare)
    {
        super(null, false);
    }
}
class GrammarMatch
{
    document: TextDocument;
    patternItem: PatternItem;
    patternName: string;
    scope: GrammarScope;
    startOffset: number;
    endOffset: number;
    matched: boolean = true;
    children: GrammarMatch[] = [];
    get start() { return this.document.positionAt(this.startOffset); }
    get end() { return this.document.positionAt(this.endOffset); }
    get text() { return this.document.getText({ start: this.start, end: this.end }); }
    get pattern() { return this.patternItem.pattern; }
    constructor(doc: TextDocument, patternItem: PatternItem)
    {
        this.document = doc;
        this.patternItem = patternItem;
    }
    toString(): string
    {
        return this.text;
    }
}
class UnMatchedText extends GrammarMatch
{
    matched = false;
    constructor(doc: TextDocument, scope: GrammarScope)
    {
        super(doc, null);
        this.scope = scope;
    }
}
class PatternDictionary
{
    [key: string]: GrammarPattern;
}
class PatternScopeDictionary
{
    [key: string]: GrammarScope;
}
class GrammarScope
{
    begin: string;
    end: string;
    patterns?: GrammarPattern[];
    scopes?: GrammarScope[];
    name?: string;
    ignore?: GrammarPattern;
    pairMatch?: string[][];
}
class GrammarPattern
{
    static String: GrammarPattern = { patterns: ["<string>"], name: "String" };
    static Number: GrammarPattern = { patterns: ['<number>'], name: "Number" };
    static Identifier: GrammarPattern = { patterns: ['<identifier>'], name: "Identifier" };
    patterns: string[];
    caseInsensitive?: boolean = false;
    dictionary?: PatternDictionary;
    keepSpace?: boolean = false;
    name?: string;
    crossLine?: boolean = false;
    scopes?: PatternScopeDictionary;
    _compiledPattern?: NestedPattern[];
}
class GrammarDeclare
{
    patterns?: GrammarPattern[];
    name?: string;
    ignore?: GrammarPattern;
    stringDelimiter?: string[];
    pairMatch?: string[][];
}
function analyseBracketItem(item: string, pattern: GrammarPattern): PatternItem
{
    const buildInPattern: PatternItemDictionary = {
        "string": (pt: GrammarPattern) => new StringPattern(pt),
        "number": (pt: GrammarPattern) => new NumberPattern(pt),
        "identifier": (pt: GrammarPattern) => new IdentifierPattern(pt),
        " ": (pt: GrammarPattern) => new EmptyPattern(pt),
    }
    if (item[0] === "<" && item[item.length - 1] === ">")
    {
        let subPattern: PatternItem;
        let name = item.substr(1, item.length - 2);
        if (buildInPattern[name])
            subPattern = buildInPattern[name](pattern);
        else if (pattern.dictionary && pattern.dictionary[name])
            subPattern = compilePattern(pattern.dictionary[name]);
        else
            subPattern = new IdentifierPattern(pattern);
        subPattern.ignorable = false;
        return subPattern;
    }
    else if (item[0] === "[" && item[item.length - 1] === "]")
    {
        item = item.substr(1, item.length - 2);
        let multi = false;
        if (item.endsWith("..."))
        {
            multi = true;
            item = item.substr(0, item.length - 3);
        }
        let subPattern = analysePatternItem(item, pattern);
        subPattern.ignorable = true;
        subPattern.multi = multi;
        return subPattern;
    }
    else if (item[0] === "{" && item[item.length - 1] === "}")
    {
        let name = item.substr(1, item.length - 2);
        let scope = pattern.scopes ? pattern.scopes[name] : null;
        if (!scope)
            throw new Error("Pattern undefined.");
        return compileScope(scope, pattern);
    }
    else if (item.startsWith("/") && item.endsWith("/"))
    {
        let reg = item.substr(1, item.length - 2);
        let subPattern = new RegExpPattern(pattern, new RegExp(reg, pattern.caseInsensitive ? "i" : ""), false);
        subPattern.name = reg;
        return subPattern;
    }
    throw new Error("Syntax Error.");
}
function analysePatternItem(item: string, pattern: GrammarPattern): PatternItem
{
    const bracketStart = ["<", "[", "{", "/"];
    const bracketEnd = [">", "]", "}", "/"];
    const spaceChars = [" "];
    const isBracketStart = (chr: string): boolean => bracketStart.indexOf(chr) >= 0;
    const isBracketEnd = (chr: string): boolean => bracketEnd.indexOf(chr) >= 0;
    const isSpace = (chr: string): boolean => spaceChars.indexOf(chr) >= 0;
    enum State { CollectWords, MatchBracket };

    let patternItem: NestedPattern = new NestedPattern(pattern, false);
    let state:State = State.CollectWords;
    let bracketDepth = 0;
    let startBracket = "";
    let words = "";

    for (let i = 0; i < item.length; i++)
    {
        if (state === State.CollectWords)
        {
            if (item[i] === "\\")
            {
                words += item[++i];
                continue;
            }
            if (isBracketStart(item[i]))
            {
                if (words !== "")
                    patternItem.addSubPattern(new TextPattern(pattern, words));
                words = item[i];
                state = State.MatchBracket;
                bracketDepth++;
                continue;
            }
            else if (isSpace(item[i]))
            {
                if (words !== "")
                    patternItem.addSubPattern(new TextPattern(pattern, words));
                words = "";
                if (pattern.keepSpace)
                    patternItem.addSubPattern(new EmptyPattern(pattern, false));
                continue;
            }
            else if (isBracketEnd(item[i]))
                throw new Error("Syntax error.");
            else
            {
                words += item[i];
                continue;
            }
        }
        else if (state === State.MatchBracket)
        {
            if (item[i] === "\\")
            {
                words += (item[i] + item[++i]);
                continue;
            }
            words += item[i];
            if (isBracketEnd(item[i]))
            {
                bracketDepth--;
                if (bracketDepth === 0)
                {
                    patternItem.addSubPattern(analyseBracketItem(words, pattern));
                    words = "";
                    state = State.CollectWords;
                    continue;
                }
            }
            else if (isBracketStart(item[i]))
                bracketDepth++;
        }
    }

    if (state === State.CollectWords && words !== "")
        patternItem.addSubPattern(new TextPattern(pattern, words, false, pattern.caseInsensitive));
    else if (state === State.MatchBracket && bracketDepth > 0)
        throw new Error("Syntax error.");
    
    if (patternItem.subPatterns.length === 0)
        throw new Error("No pattern.");
    else if (patternItem.subPatterns.length === 1)
    {
        patternItem.subPatterns[0].ignorable = patternItem.ignorable;
        return patternItem.subPatterns[0];
    }
    return patternItem;
}
function compilePattern(pattern: GrammarPattern): PatternItem
{
    if (pattern === GrammarPattern.String)
        return new StringPattern(pattern);
    let patternList: OptionalPatterns = new OptionalPatterns(pattern, true);
    pattern.patterns.forEach(pt =>
    {
        let subPattern = analysePatternItem(pt, pattern);
        subPattern.ignorable = true;
        patternList.addSubPattern(subPattern);
    });
    if (patternList.count === 0)
        throw new Error("No pattern.");
    if (patternList.count === 1)
    {
        patternList.subPatterns[0].ignorable = true;
        return patternList.subPatterns[0];
    }
    return patternList;
}
function compileScope(scope: GrammarScope, pattern:GrammarPattern): PatternScope
{
    let patternList = new PatternScope(pattern, scope);
    patternList.addSubPattern(new TextPattern(pattern, scope.begin, false));
    scope.patterns.forEach(pattern =>
    {
        let subPattern = compilePattern(pattern);
        subPattern.ignorable = true;
        subPattern.multi = true;
        patternList.addSubPattern(subPattern);
    });
    patternList.addSubPattern(new TextPattern(pattern, scope.end, false));
    patternList.name = scope.name ? scope.name : "Scope";
    return patternList;
}
function compileGrammar(grammarDeclare: GrammarDeclare):Grammar
{
    let grammar = new Grammar(grammarDeclare);
    grammarDeclare.patterns.forEach(pattern => grammar.addSubPattern(compilePattern(pattern)));
    return grammar;
}

function matchGrammar(grammar: Grammar, doc: TextDocument): GrammarMatch
{
    let root = new GrammarMatch(doc, grammar);
    root.startOffset = 0;
    root.endOffset = doc.getText().length;
    return grammar.match(doc, 0);
}
export { ShaderCode, Scope, ScopeDeclare, GrammarDeclare, GrammarPattern, compileGrammar, matchGrammar };