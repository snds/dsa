/**
 * The engine behind `dsa run`, for add-ons (@snds/dsa-review, -dashboard, -figma, -agent): import
 * from "@snds/dsa/engine". It is the analytics suite's engine as ported; names may change between minor
 * versions until the readers meet (see docs/architecture.md).
 */
export * from './catalog.js';
export * from './classify-a11y.js';
export * from './classify-button.js';
export * from './classify-fields.js';
export * from './classify-look.js';
export * from './classify-parts.js';
export * from './classify-region.js';
export * from './classify-semantics.js';
export * from './classify.js';
export * from './config.js';
export * from './elements.js';
export * from './evaluate.js';
export * from './events.js';
export * from './figma-links.js';
export * from './fit.js';
export * from './from-dsa.js';
export * from './hints.js';
export * from './host-context.js';
export * from './identity.js';
export * from './issues.js';
export * from './mapping.js';
export * from './metrics.js';
export * from './modules.js';
export * from './paths.js';
export * from './pipeline.js';
export * from './placement.js';
export * from './questions.js';
export * from './reach.js';
export * from './readiness.js';
export * from './remotes.js';
export * from './rendered.js';
export * from './review.js';
export * from './roles.js';
export * from './rules.js';
export * from './secrets.js';
export * from './settings.js';
export * from './signatures.js';
export * from './source.js';
export * from './store.js';
export * from './system.js';
export * from './tailwind.js';
export * from './types.js';
export * from './workspaces.js';
export * from './scanners/ast.js';
export * from './scanners/children.js';
export * from './scanners/code.js';
export * from './scanners/features.js';
export * from './scanners/semantics.js';
export * from './scanners/table.js';
export * from './scanners/tokens.js';
export * from './scanners/versions.js';
export { switchKindOf } from './classify-button.js';
