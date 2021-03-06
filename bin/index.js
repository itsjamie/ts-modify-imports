#!/usr/bin/env node

const fs = require('fs');
const ts = require('typescript');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { factory } = require('typescript');
const argv = yargs(hideBin(process.argv))
  .example('$0 "./source-file.ts"')
  .usage('$0 <file>', 'Rewrite your imports using the Typescript AST. Use "import type" where possible.', (yargs) => { 
    yargs.option('s', {
      alias: 'semicolon',
      default: false,
      describe: 'Output imports with trailing semicolons',
      type: 'boolean'
    })
    yargs.positional('file', {
      describe: 'File path that will be read.',
      type: 'string'
    })
  })
  .argv;

const configFileName = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
const configFile = ts.readConfigFile(configFileName, ts.sys.readFile);
const compilerOptions = ts.parseJsonConfigFileContent(configFile.config, ts.sys, "./");
compilerOptions.options.noEmit = true
const program = ts.createProgram([argv.file], compilerOptions);
const typeChecker = program.getTypeChecker();


const Imports = new Map()
const ImportsByModuleSpecifier = new Map()
const ImportDeclarationsByModuleSpecifier = new Map()

/**
 * Populates the Imports map with information about how imported symbols are used in the source file.
 * @param {ts.Node} node 
 * @param {ts.SourceFile} sourceFile 
 */
function collectUsageOfImportSymbols(node, sourceFile) {
  const syntaxKind = ts.SyntaxKind[node.kind];

  if (ts.isImportDeclaration(node)) {
    // only handle named imports
    if (node.importClause && !node.importClause.namedBindings) return
    if (ts.isNamedImports(node.importClause.namedBindings) == false) return
    // If there is a default import we want to skip this.
    // todo(verbose log)
    if (node.importClause.name) return

    node.importClause.namedBindings.elements.forEach((element) => {
      const symbol = typeChecker.getSymbolAtLocation(element.name)
      if (node.importClause.isTypeOnly) {
        Imports.set(symbol, false)
      } else {
        Imports.set(symbol, null)
      }
    })
  } else if (ts.isIdentifier(node)) {
    const symbol = typeChecker.getSymbolAtLocation(node)
    if (Imports.has(symbol)) {
      const result = Imports.get(symbol)
      const type = !ts.isTypeNode(node.parent)
      if (result != true) {
        Imports.set(symbol, type)
      }
    }
  } else {
    node.forEachChild(child =>
      collectUsageOfImportSymbols(child, sourceFile)
    );
  }
}
const sourceFile = program.getSourceFile(argv.file)
sourceFile.forEachChild(child =>
  collectUsageOfImportSymbols(child, sourceFile)
);

/**
 * Utilizing the collected information about the imported symbols, let's transform our import declarations
 * @param {ts.TransformationContext} context 
 */
const transformer = (context) => {
  /**
   * @param {ts.Node} rootNode
   */
  return (rootNode) => {
    /**
     * @param {ts.Node} node 
     */
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        // only handle named imports
        if (node.importClause && !node.importClause.namedBindings) return
        if (ts.isNamedImports(node.importClause.namedBindings) == false) return
        if (node.importClause.name) return

        const typeOnly = node.importClause.isTypeOnly
        let importData = ImportsByModuleSpecifier.get(node.moduleSpecifier.getText(sourceFile))
        
        // Used to inspect if we have the existance of the other import statement, or if we should create it
        const postfix = typeOnly ? "-runtime" : "-types";
        const importDeclsKey = node.moduleSpecifier.getText(sourceFile) + postfix;
        const shouldCreateAlternate = !ImportDeclarationsByModuleSpecifier.has(importDeclsKey)

        if (!typeOnly) {
          if (importData.runtime.length == 0) { 
            if (!shouldCreateAlternate) return undefined
            // we running, and we have no runtime values used here, only types
            const specifiers = importData.types.map((symbol) => {
              return context.factory.createImportSpecifier(undefined, context.factory.createIdentifier(symbol.escapedName))
            })
            return context.factory.updateImportDeclaration(node, node.decorators, node.modifiers, context.factory.updateImportClause(node.importClause, true, node.importClause.name, context.factory.createNamedImports(specifiers)), node.moduleSpecifier)
            
          }
          //runtime imports
          const specifiers = importData.runtime.map((symbol) => {
            return context.factory.createImportSpecifier(undefined, context.factory.createIdentifier(symbol.escapedName))
          })
          const updatedImportDecl = context.factory.updateImportDeclaration(node, node.decorators, node.modifiers, context.factory.updateImportClause(node.importClause, node.importClause.isTypeOnly, node.importClause.name, context.factory.createNamedImports(specifiers)), node.moduleSpecifier)
          
          // check to see if there is an existing import type clause
          // if not, create one and return it here.
          if (!ImportDeclarationsByModuleSpecifier.has(importDeclsKey) && importData.types.length) {
            const specifiers = importData.types.map((symbol) => {
              return context.factory.createImportSpecifier(undefined, context.factory.createIdentifier(symbol.escapedName))
            })
            const typeDecl = context.factory.createImportDeclaration(undefined, undefined, context.factory.createImportClause(true, undefined, context.factory.createNamedImports(specifiers)), node.moduleSpecifier)
            return [typeDecl, updatedImportDecl]
          }          
          // if there is, do nothing here, we'll catch the updates there.
          return updatedImportDecl
        }

        // TODO: handle existing import type imports
        // for testing, removing import type imports
        return undefined
      } else {
        return ts.visitEachChild(node, visit, context)
      }
    }
    return ts.visitNode(rootNode, visit)
  }
}

/**
 * @param {ts.SourceFile} sourceFile 
 */
function modifyImportsByUsage(sourceFile) {
  sourceFile.statements.forEach(stmt => {
    if (ts.isImportDeclaration(stmt)) {
      const runtime = []
      const types = []
      // only handle named imports
      if (stmt.importClause && !stmt.importClause.namedBindings) return
      if (ts.isNamedImports(stmt.importClause.namedBindings) == false) return
      if (stmt.importClause.name) return

      if (!stmt.importClause.isTypeOnly) {
        ImportDeclarationsByModuleSpecifier.set(stmt.moduleSpecifier.getText(sourceFile) + "-runtime", true)
      } else {
        ImportDeclarationsByModuleSpecifier.set(stmt.moduleSpecifier.getText(sourceFile) + "-types", true)
      }

      stmt.importClause.namedBindings.elements.forEach((element) => {
        if (Imports.get(element.symbol)) {
          runtime.push(element.symbol)
        } else {
          types.push(element.symbol)
        }
      });
      
      if (ImportsByModuleSpecifier.has(stmt.moduleSpecifier.getText(sourceFile))) {
        const imports = ImportsByModuleSpecifier.get(stmt.moduleSpecifier.getText(sourceFile))
        imports.runtime = imports.runtime.concat(runtime)
        imports.types = imports.types.concat(...types)
        ImportsByModuleSpecifier.set(stmt.moduleSpecifier.getText(sourceFile), imports);
      } else {
        ImportsByModuleSpecifier.set(stmt.moduleSpecifier.getText(sourceFile), {
          runtime,
          types
        });
      }
    }
  })

  return ts.transform(sourceFile, [ transformer ], compilerOptions)
}

const result = modifyImportsByUsage(sourceFile)
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

let replacements = []
let storedLines = []
result.transformed[0].statements.forEach((node) => {
  if (ts.isImportDeclaration(node)) {
    let n = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
    if (node.original && node.original.getText(sourceFile) === n) return
    if (!argv.semicolon) {
      n = n.replace(';', '')
    }

    storedLines.push(n)
    if (node.original && node.original.getText(sourceFile) !== n) {
      const target = printer.printNode(ts.EmitHint.Unspecified, node.original, sourceFile)
      const replacement = storedLines.join("\n");
      storedLines = [];
      replacements.push({
        target: target.replace(';', ''),
        replacement: replacement
      });
    }
  }
})

console.log(replacements)

let source = sourceFile.getText()
replacements.forEach((o) => {
  source = source.replace(o.target, o.replacement)
})

fs.writeFileSync(argv.file, source);