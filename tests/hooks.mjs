export async function resolve(specifier, context, next) {
  if (specifier === '@kabelsalat/web') {
    return next(new URL('../node_modules/@kabelsalat/web/dist/index.mjs', import.meta.url).href, context);
  }
  return next(specifier, context);
}
