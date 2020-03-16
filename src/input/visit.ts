import {
  TypeChecker,
  Node,
  Type,
  TypeFlags,
  SymbolFlags,
  Symbol,
  InterfaceTypeWithDeclaredMembers,
  VariableDeclaration,
  TypeAliasDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isClassDeclaration,
  FunctionDeclaration,
  Signature,
  ExportAssignment,
  TypeNode,
  ObjectFlags,
  IndexInfo,
  isFunctionDeclaration,
  SyntaxKind,
  isMethodSignature,
} from 'typescript';
import { createBinding } from './utils';
import {
  getLib,
  isBaseLib,
  isAnonymousObject,
  isObjectType,
  isReferenceType,
  isBigIntLiteral,
  getKeyName,
  isIndexType,
  isGlobal,
  getGlobalName,
  isTupleType,
  isKeyOfType,
  isIdentifierType,
  isConditionalType,
  isInferType,
  isSubstitutionType,
  isAnonymous,
  getConstructors,
  getModifiers,
  isHiddenAnonymousType,
  isUnionType,
} from '../helpers';
import {
  TypeModel,
  TypeModelIndex,
  TypeModelProp,
  TypeModelFunction,
  DeclVisitorContext,
  TypeModelRef,
  TypeMemberModel,
  TypeModelPrefix,
  TypeModelInterface,
  TypeModelIndexKey,
  TypeModelClass,
  TypeModelFunctionParameter,
  TypeModelConstructor,
} from '../types';

const allowedBaseTypes = ['object', 'class'];

function isClassOrObject(type: TypeModel): type is TypeModelInterface | TypeModelClass {
  return type && allowedBaseTypes.includes(type.kind);
}

function getTypeArguments(context: DeclVisitorContext, type: any): Array<TypeModel> {
  return type.typeArguments?.map(t => includeType(context, t)) ?? [];
}

function getTypeParameters(context: DeclVisitorContext, type: any): Array<TypeModel> {
  return type.typeParameters?.map(t => includeTypeParameter(context, t)) ?? [];
}

function getDefaultTypeId(context: DeclVisitorContext, type: Type): number {
  const symbol = type?.symbol;
  const decl = symbol?.declarations?.[0];
  const defaultNode = decl?.default;

  if (defaultNode) {
    const defaultType = context.checker.getTypeAtLocation(defaultNode);
    return defaultType?.id;
  }

  return undefined;
}

function getComment(checker: TypeChecker, symbol: Symbol): string {
  const doc = symbol?.getDocumentationComment(checker);
  return doc?.map(item => item.text).join('\n');
}

function getTypeModel(context: DeclVisitorContext, type: Type, name?: string) {
  if (name) {
    if (type.aliasSymbol) {
      if (!type.symbol || type.aliasSymbol.id !== type.symbol.id) {
        return makeAliasRef(context, type, name);
      }
    }

    const ext = includeExternal(context, type);

    if (ext) {
      return ext;
    } else if (!isAnonymous(name) && !isAnonymousObject(type)) {
      return makeRef(context, type, name, includeNamed);
    }
  }

  return includeAnonymous(context, type);
}

function getParameterType(context: DeclVisitorContext, type: TypeNode): TypeModel {
  if (isIdentifierType(type)) {
    const t = context.checker.getTypeAtLocation(type);
    return getTypeModel(context, t, (type.typeName as any).text);
  } else if (isInferType(type)) {
    const t = context.checker.getDeclaredTypeOfSymbol(type.typeParameter.symbol);
    return {
      kind: 'infer',
      parameter: includeType(context, t),
    };
  } else {
    return includeAnonymousNode(context, type);
  }
}

function getFunctionParameters(
  context: DeclVisitorContext,
  parameters: Array<Symbol>,
): Array<TypeModelFunctionParameter> {
  return parameters.map(param => ({
    kind: 'parameter',
    param: param.name,
    modifiers: '',
    spread: param.valueDeclaration.dotDotDotToken !== undefined,
    optional: param.valueDeclaration.questionToken !== undefined,
    value: getParameterType(context, param.valueDeclaration.type as any),
  }));
}

function getFunctionType(context: DeclVisitorContext, sign: Signature): TypeModelFunction {
  return {
    kind: 'function',
    types: getTypeParameters(context, sign as any),
    parameters: getFunctionParameters(context, sign.getParameters()),
    returnType: includeType(context, sign.getReturnType()),
  };
}

function getConstructorTypes(context: DeclVisitorContext, type: Type): Array<TypeModelConstructor> {
  const ctors = getConstructors(type);
  return (
    ctors?.map(ctor => {
      const signature = context.checker.getSignatureFromDeclaration(ctor as any);
      const type = getFunctionType(context, signature);
      return {
        ...type,
        kind: 'constructor',
      };
    }) ?? []
  );
}

function getKeyOfType(context: DeclVisitorContext, type: Type): TypeModelPrefix {
  return {
    kind: 'prefix',
    prefix: 'keyof',
    value: includeType(context, type),
  };
}

function includeNode(context: DeclVisitorContext, type: Node): TypeModel {
  if (isKeyOfType(type)) {
    return getKeyOfType(context, context.checker.getTypeFromTypeNode(type.type));
  } else if (isUnionType(type)) {
    return getUnion(context, type.types.map(context.checker.getTypeFromTypeNode));
  }
}

function getPropValue(context: DeclVisitorContext, prop: Symbol): TypeModel {
  const decl = prop.declarations[0];
  const type =
    includeNode(context, decl.type) ?? includeType(context, context.checker.getTypeOfSymbolAtLocation(prop, decl));

  if (isMethodSignature(decl)) {
    const parameters = decl.parameters.map(p => p.symbol);
    return {
      kind: 'function',
      parameters: getFunctionParameters(context, parameters),
      returnType: type,
      types: getTypeParameters(context, decl),
      comment: undefined,
    };
  }

  return type;
}

function getPropType(context: DeclVisitorContext, prop: Symbol): TypeModelProp {
  const valueType = getPropValue(context, prop);

  return {
    kind: 'prop',
    name: prop.name,
    modifiers: getModifiers(prop),
    id: prop.id || prop.target?.id,
    optional: !!(prop.flags & SymbolFlags.Optional),
    comment: getComment(context.checker, prop),
    valueType,
  };
}

function getIndexType(
  context: DeclVisitorContext,
  type: Type,
  keyType: TypeModelIndexKey,
  info: IndexInfo,
): TypeModelIndex {
  return {
    kind: 'index',
    parameters: [
      {
        kind: 'parameter',
        param: getKeyName(info),
        modifiers: '',
        optional: false,
        spread: false,
        value: keyType,
      },
    ],
    optional: false,
    valueType: includeType(context, type),
  };
}

function getUnion(context: DeclVisitorContext, types: Array<Type>): TypeModel {
  return {
    kind: 'union',
    types: types.map(t => includeType(context, t)),
  };
}

function normalizeTypeParameters(
  context: DeclVisitorContext,
  type: Type,
  decl: Type,
  types: Array<TypeModel>,
  refName: string,
) {
  const maxTypes = (context.refs[refName] as any)?.types?.length ?? Number.MAX_SAFE_INTEGER;
  const typeParameterIds = decl?.typeParameters?.map(t => getDefaultTypeId(context, t)) ?? [];
  const typeArgumentIds = type.aliasTypeArguments?.map(t => t.id) ?? (type as any).typeArguments?.map(t => t.id) ?? [];

  // omit types that are not listed on the original type parameters
  while (types.length > maxTypes) {
    types.pop();
  }

  for (let i = typeParameterIds.length; i--; ) {
    const id = typeParameterIds[i];

    if (!id || id !== typeArgumentIds[i]) {
      break;
    }

    types.pop();
  }

  return types;
}

function includeHiddenAnonymous(context: DeclVisitorContext, type: Type) {
  const name = type.symbol?.name;

  if (isAnonymous(name)) {
    // Right now this catches the JSXElementConstructor; but
    // I guess this code should be made "more robust" and also
    // more generic.
    const parent: any = type.symbol?.declarations?.[0]?.parent;
    const hiddenType = parent?.type?.parent?.parent?.parent;

    if (isHiddenAnonymousType(hiddenType)) {
      const hiddenTypeName = hiddenType?.symbol?.name;

      if (hiddenTypeName) {
        return includeType(context, hiddenType);
      }
    }
  }
}

function includeExternal(context: DeclVisitorContext, type: Type) {
  if (isGlobal(type.symbol)) {
    const globalName = getGlobalName(type.symbol);
    return includeRef(context, type, globalName);
  }

  const name = type.symbol?.name;
  const fn = type.symbol?.declarations?.[0]?.parent?.getSourceFile()?.fileName;

  if (isBaseLib(fn)) {
    // Include items from the ts core lib (no need to ref. them)
    return includeRef(context, type, name, type);
  }

  const lib = getLib(fn, context.availableImports);

  if (lib) {
    if (isAnonymous(name)) {
      return includeHiddenAnonymous(context, type);
    } else if (!isAnonymousObject(type)) {
      return includeRef(context, type, createBinding(context, lib, name), type);
    }
  }
}

export function includeExportedType(context: DeclVisitorContext, type: Type) {
  const name = type.symbol.name;
  const node = includeType(context, type);

  // okay we got a non-ref back, hence it was not yet added to the refs
  if (node.kind !== 'ref') {
    context.refs[name] = node;
  }
}

export function includeDefaultExport(context: DeclVisitorContext, node: ExportAssignment) {
  const type = context.checker.getTypeAtLocation(node.expression);
  const symbol = context.checker.getSymbolAtLocation(node.expression);

  if (symbol) {
    if (symbol.flags === SymbolFlags.TypeAlias) {
      includeExportedTypeAlias(context, symbol.declarations[0] as any);
    } else if (symbol.flags === SymbolFlags.Function) {
      includeExportedFunction(context, symbol.valueDeclaration as any, node.name.text);
    } else {
      includeExportedVariable(context, symbol.valueDeclaration as any);
    }

    context.refs.default = {
      kind: 'default',
      comment: getComment(context.checker, node.symbol),
      value: includeRef(context, type, symbol.name),
    };
  } else {
    if (isFunctionDeclaration(node)) {
      includeExportedFunction(context, node, '_default');
    } else {
      context.refs._default = {
        kind: 'const',
        value: includeAnonymous(context, type),
      };
    }
    context.refs.default = {
      kind: 'default',
      comment: getComment(context.checker, node.symbol),
      value: includeRef(context, type, '_default'),
    };
  }
}

export function includeExportedTypeAlias(context: DeclVisitorContext, variable: TypeAliasDeclaration) {
  const name = (variable.name as any).text;

  context.refs[name] = {
    kind: 'alias',
    comment: getComment(context.checker, variable.symbol),
    types: getTypeParameters(context, variable as any),
    child: getParameterType(context, variable.type),
  };
}

export function includeExportedVariable(context: DeclVisitorContext, variable: VariableDeclaration) {
  const name = (variable.name as any).text;
  const type = variable.type
    ? context.checker.getTypeFromTypeNode(variable.type)
    : context.checker.getTypeAtLocation(variable.initializer);
  context.refs[name] = {
    kind: 'const',
    comment: getComment(context.checker, variable.symbol),
    value: includeType(context, type),
  };
}

export function includeExportedFunction(context: DeclVisitorContext, func: FunctionDeclaration, name: string) {
  const type = context.checker.getTypeAtLocation(func as any);
  const [signature] = type.getCallSignatures();
  const funcType = getFunctionType(context, signature);
  context.refs[name] = {
    ...funcType,
    comment: getComment(context.checker, func.symbol),
  };
}

function includeType(context: DeclVisitorContext, type: Type): TypeModel {
  const ta = type as any;

  if (ta.stringsOnly === false) {
    return {
      kind: 'prefix',
      prefix: 'keyof',
      value: includeType(context, ta.type),
    };
  } else {
    const alias = type.aliasSymbol?.name;
    return getTypeModel(context, type, alias || type.symbol?.name);
  }
}

function makeAliasRef(context: DeclVisitorContext, type: Type, name: string): TypeModel {
  const decl: any = type.aliasSymbol.declarations[0];
  const ext = includeExternal(context, decl);

  if (ext && ext.kind === 'ref') {
    name = ext.refName;
  } else if (!(name in context.refs)) {
    context.refs[name] = {
      kind: 'ref',
      types: [],
      refName: name,
    };

    context.refs[name] = {
      kind: 'alias',
      comment: getComment(context.checker, decl.symbol),
      types: decl.typeParameters?.map(t => includeTypeParameter(context, t)) ?? [],
      child: includeAnonymous(context, context.checker.getTypeAtLocation(decl)),
    };
  }

  const types = type.aliasTypeArguments?.map(t => includeType(context, t)) ?? [];

  return {
    kind: 'ref',
    types: normalizeTypeParameters(context, type, decl, types, name),
    refName: name,
  };
}

function makeRef(
  context: DeclVisitorContext,
  type: Type,
  name: string,
  cb: (context: DeclVisitorContext, type: Type) => TypeModel,
) {
  const refType = type;

  if (!(name in context.refs)) {
    context.refs[name] = {
      kind: 'ref',
      types: [],
      refName: name,
    };

    if (isObjectType(type) && isReferenceType(type)) {
      type = type.target;
    }

    context.refs[name] = cb(context, type);
  }

  return includeRef(context, refType, name);
}

function includeRef(context: DeclVisitorContext, type: Type, refName: string, external?: Type): TypeModel {
  const decl: any = type.symbol?.declarations[0];
  const types = getTypeArguments(context, type);

  return {
    kind: 'ref',
    types: normalizeTypeParameters(context, type, decl, types, refName),
    refName,
    external,
  };
}

function includeMember(context: DeclVisitorContext, type: Type): TypeMemberModel {
  return {
    kind: 'member',
    name: type.symbol.name,
    value: includeAnonymous(context, type),
    comment: getComment(context.checker, type.symbol),
  };
}

function includeBasic(context: DeclVisitorContext, type: Type): TypeModel {
  // We're not handling things SomethingLike cause there're unions of flags
  // and would be handled anyway into more specific types
  // VoidLike is Undefined or Void,
  // StringLike is String or StringLiteral
  // NumberLike is Number or NumberLiteral or Enum
  // BigIntLike is BigInt or BigIntLiteral
  // ESSymbolLike is ESSymbol or ESUniqueSymbol
  // Don't take those ^ definitions too seriously, they're subject to change

  if (type.flags & TypeFlags.Any) {
    return {
      kind: 'any',
    };
  }

  if (type.flags & TypeFlags.Unknown) {
    return {
      kind: 'unknown',
    };
  }

  if (typeof type.isStringLiteral === 'function' && type.isStringLiteral()) {
    return {
      kind: 'literal',
      value: type.value,
    };
  }

  if (typeof type.isNumberLiteral === 'function' && type.isNumberLiteral()) {
    return {
      kind: 'literal',
      value: type.value,
    };
  }

  if (type.flags & TypeFlags.BooleanLiteral) {
    return {
      kind: 'literal',
      // FIXME It's a dirty hack but i can't seem to find any other way to get a value of BooleanLiteral
      value: (type as any).intrinsicName === 'true',
    };
  }

  if (type.flags & TypeFlags.EnumLiteral && type.isUnion()) {
    return {
      kind: 'enumLiteral',
      const: type.symbol.flags === SymbolFlags.ConstEnum,
      comment: getComment(context.checker, type.symbol),
      values: type.types.map(t => includeMember(context, t)),
    };
  }

  if (type.flags & TypeFlags.Enum && type.isUnion()) {
    return {
      kind: 'enum',
      comment: getComment(context.checker, type.symbol),
      values: type.types.map(t => includeMember(context, t)),
    };
  }

  if (isBigIntLiteral(type)) {
    return {
      kind: 'bigintLiteral',
      value: type.value,
    };
  }

  if (type.flags & TypeFlags.String) {
    return {
      kind: 'string',
    };
  }

  if (type.flags & TypeFlags.Boolean) {
    return {
      kind: 'boolean',
    };
  }

  if (type.flags & TypeFlags.Number) {
    return {
      kind: 'number',
    };
  }

  if (type.flags & TypeFlags.BigInt) {
    return {
      kind: 'bigint',
    };
  }

  if (type.flags & TypeFlags.ESSymbol) {
    return {
      kind: 'esSymbol',
    };
  }

  if (type.flags & TypeFlags.UniqueESSymbol) {
    return {
      kind: 'uniqueEsSymbol',
    };
  }

  if (type.flags & TypeFlags.Void) {
    return {
      kind: 'void',
    };
  }

  if (type.flags & TypeFlags.Undefined) {
    return {
      kind: 'undefined',
    };
  }

  if (type.flags & TypeFlags.Null) {
    return {
      kind: 'null',
    };
  }

  if (type.flags & TypeFlags.Never) {
    return {
      kind: 'never',
    };
  }

  if (isConditionalType(type)) {
    return {
      kind: 'conditional',
      extends: includeType(context, type.root.extendsType),
      check: includeType(context, type.root.checkType),
      primary: includeType(context, type.root.trueType),
      alternate: includeType(context, type.root.falseType),
    };
  }

  if (isSubstitutionType(type)) {
    return {
      kind: 'substitution',
      variable: includeType(context, type.typeVariable),
    };
  }

  if (type.flags & TypeFlags.NonPrimitive) {
    return {
      kind: 'nonPrimitive',
      name: type.intrinsicName,
    };
  }
}

function includeInheritedTypes(context: DeclVisitorContext, type: Type) {
  const decl = type?.symbol?.declarations?.[0];
  const result = {
    extends: [] as Array<TypeModelRef>,
    implements: [] as Array<TypeModelRef>,
  };

  if (decl && (isInterfaceDeclaration(decl) || isClassDeclaration(decl))) {
    const types = decl?.heritageClauses ?? [];

    for (const type of types) {
      const items =
        type.types?.map(t => {
          const ti = context.checker.getTypeAtLocation(t);
          const res = includeType(context, ti) as TypeModelRef;

          if (res.kind !== 'ref' && isIdentifier(t.expression)) {
            return {
              kind: 'ref',
              refName: t.expression.text,
              types: [],
              external: ti,
            } as TypeModelRef;
          }

          return res;
        }) ?? [];

      if (type.token === SyntaxKind.ExtendsKeyword) {
        result.extends.push(...items);
      } else if (type.token === SyntaxKind.ImplementsKeyword) {
        result.implements.push(...items);
      }
    }
  }

  return result;
}

function includeConstraint(context: DeclVisitorContext, type: Type): TypeModel {
  const symbol = type.symbol;
  const decl: any = symbol.declarations?.[0];
  const c = decl?.constraint;
  const constraint = c?.type ?? type.getConstraint?.();

  if (isKeyOfType(c)) {
    const ct = context.checker.getTypeAtLocation(c.type);
    return getKeyOfType(context, ct);
  } else if (c) {
    const ct = context.checker.getTypeAtLocation(c);
    return includeType(context, ct);
  } else if (constraint) {
    return includeType(context, constraint);
  }

  return undefined;
}

function includeDefaultTypeArgument(context: DeclVisitorContext, type: Type): TypeModel {
  const symbol = type.symbol;
  const decl: any = symbol.declarations?.[0];
  const defaultNode = decl?.default;

  if (defaultNode) {
    const defaultType = context.checker.getTypeAtLocation(defaultNode);
    return includeType(context, defaultType);
  }

  return undefined;
}

function includeTypeParameter(context: DeclVisitorContext, type: Type): TypeModel {
  const symbol = type.symbol;

  if (symbol) {
    return {
      kind: 'typeParameter',
      parameter: {
        kind: 'ref',
        refName: symbol.name,
        types: [],
      },
      constraint: includeConstraint(context, type),
      default: includeDefaultTypeArgument(context, type),
    };
  }
}

function getAllPropIds(context: DeclVisitorContext, types: Array<TypeModel>) {
  const propIds: Array<number> = [];

  for (const type of types) {
    const ref = type as TypeModelRef;
    const baseType = context.refs[ref.refName];

    if (isClassOrObject(baseType)) {
      for (const prop of baseType.props) {
        const id = (prop as any).id;

        if (id) {
          propIds.push(id);
        }
      }

      propIds.push(...getAllPropIds(context, baseType.extends));
    } else if (ref.external) {
      const props = ref.external.getProperties() || [];

      for (const prop of props) {
        propIds.push(prop.id || prop.target?.id);
      }
    }
  }

  return propIds;
}

function includeStandardObject(context: DeclVisitorContext, type: Type): TypeModelInterface {
  const inheritedTypes = includeInheritedTypes(context, type);
  const inherited = [...inheritedTypes.extends, ...inheritedTypes.implements];
  const targets = getAllPropIds(context, inherited);
  const props = type.getProperties();
  const propsDescriptor: Array<TypeModel> = props
    .filter(prop => !targets.includes(prop.id || prop.target?.id))
    .map(prop => getPropType(context, prop));

  // index types
  const stringIndexType = type.getStringIndexType();
  const numberIndexType = type.getNumberIndexType();

  if (numberIndexType && !inherited.some(m => m.external?.getNumberIndexType() === numberIndexType)) {
    propsDescriptor.push(
      getIndexType(
        context,
        numberIndexType,
        { kind: 'number' },
        (<InterfaceTypeWithDeclaredMembers>type).declaredNumberIndexInfo,
      ),
    );
  }

  if (stringIndexType && !inherited.some(m => m.external?.getStringIndexType() === stringIndexType)) {
    propsDescriptor.push(
      getIndexType(
        context,
        stringIndexType,
        { kind: 'string' },
        (<InterfaceTypeWithDeclaredMembers>type).declaredStringIndexInfo,
      ),
    );
  }

  type
    .getCallSignatures()
    ?.map(sign => getFunctionType(context, sign))
    .forEach(m => propsDescriptor.push(m));

  return {
    kind: 'interface',
    extends: inheritedTypes.extends,
    comment: getComment(context.checker, type.symbol),
    props: propsDescriptor,
    types: getTypeParameters(context, type),
  };
}

function includeClassObject(context: DeclVisitorContext, type: Type): TypeModelClass {
  const obj = includeStandardObject(context, type);
  const inheritedTypes = includeInheritedTypes(context, type);

  context.checker
    .getExportsOfModule(type.symbol)
    .filter(m => (m.flags & SymbolFlags.Prototype) === 0)
    .map(m => getPropType(context, m.valueDeclaration.symbol))
    .filter(m => m !== undefined)
    .forEach(prop => obj.props.push(prop));

  getConstructorTypes(context, type).forEach(ctor => obj.props.push(ctor));

  return {
    ...obj,
    implements: inheritedTypes.implements,
    kind: 'class',
  };
}

function includeMappedObject(context: DeclVisitorContext, type: Type): TypeModelInterface {
  const parent: any = type.typeParameter.symbol.declarations[0].parent;
  const index = parent.typeParameter;
  const declType: any = type.symbol.declarations[0].type;
  const valueType = context.checker.getTypeFromTypeNode(declType);
  return {
    kind: 'interface',
    extends: [],
    props: [],
    types: [],
    comment: getComment(context.checker, type.symbol),
    mapped: {
      kind: 'mapped',
      name: index.symbol.name,
      constraint: includeConstraint(context, index),
      optional: parent.questionToken !== undefined,
      value: includeType(context, valueType),
    },
  };
}

function includeObject(context: DeclVisitorContext, type: Type): TypeModel {
  if (isObjectType(type)) {
    switch (type.objectFlags) {
      case ObjectFlags.Mapped:
        return includeMappedObject(context, type);
      case ObjectFlags.Class | ObjectFlags.Reference:
        return includeClassObject(context, type);
      default:
        return includeStandardObject(context, type);
    }
  }

  return undefined;
}

function includeIndex(context: DeclVisitorContext, type: Type): TypeModel {
  switch (type?.flags) {
    case TypeFlags.TypeParameter:
      return includeType(context, type);
    case TypeFlags.Index:
      return getKeyOfType(context, (type as any).type);
    default:
      return undefined;
  }
}

function includeCombinator(context: DeclVisitorContext, type: Type): TypeModel {
  if (isTupleType(type)) {
    return {
      kind: 'tuple',
      types: type.typeArguments.map(t => includeType(context, t)),
    };
  }

  if (isReferenceType(type)) {
    return {
      kind: 'ref',
      refName: type.symbol.name,
      types: getTypeArguments(context, type),
      external: type,
    };
  }

  if (typeof type.isUnion === 'function' && type.isUnion()) {
    return getUnion(context, type.types);
  }

  if (typeof type.isIntersection === 'function' && type.isIntersection()) {
    return {
      kind: 'intersection',
      types: type.types.map(t => includeType(context, t)),
    };
  }

  if (isIndexType(type)) {
    return {
      kind: 'indexedAccess',
      index: includeIndex(context, type.indexType),
      object: type.objectType && includeType(context, type.objectType),
    };
  }
}

function includeReference(context: DeclVisitorContext, type: Type): TypeModel {
  if (type.kind === SyntaxKind.TypeAliasDeclaration) {
    return {
      kind: 'alias',
      comment: getComment(context.checker, type.symbol),
      types: getTypeParameters(context, type),
      child: getParameterType(context, (type as any).type),
    };
  }
}

function includeNamed(context: DeclVisitorContext, type: Type): TypeModel {
  return includeBasic(context, type) ?? includeObject(context, type) ?? includeReference(context, type);
}

function includeAnonymousNode(context: DeclVisitorContext, type: TypeNode): TypeModel {
  return includeNode(context, type) ?? includeAnonymous(context, context.checker.getTypeFromTypeNode(type));
}

function includeAnonymous(context: DeclVisitorContext, type: Type): TypeModel {
  return (
    includeBasic(context, type) ??
    includeCombinator(context, type) ??
    includeHiddenAnonymous(context, type) ??
    includeObject(context, type) ?? {
      kind: 'unidentified',
    }
  );
}
