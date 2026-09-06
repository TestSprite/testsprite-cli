import * as v from 'valibot';
import type { CliProject } from '../commands/project.js';
import type { Page } from './pagination.js';

/**
 * Project read fixtures in commands/project.test.ts and test/mock-backend/fixtures.ts
 * establish these core fields. Optional fields must stay absent when omitted:
 * in particular, an absent targetUrl means no answer, whereas null means unset.
 * Follow response-schemas.ts: preserve added fields and accept future enum strings.
 */
export const CLI_PROJECT_SCHEMA: v.GenericSchema<unknown, CliProject> = v.looseObject({
  id: v.string(),
  name: v.string(),
  type: v.custom<CliProject['type']>(value => typeof value === 'string'),
  createdFrom: v.custom<CliProject['createdFrom']>(value => typeof value === 'string'),
  createdAt: v.string(),
  updatedAt: v.string(),
  orgId: v.optional(v.string()),
  orgName: v.optional(v.string()),
  targetUrl: v.optional(v.nullable(v.string())),
  testIdAttributes: v.optional(v.nullable(v.array(v.string()))),
});

export const CLI_PROJECT_LIST_SCHEMA: v.GenericSchema<unknown, Page<CliProject>> = v.looseObject({
  items: v.array(CLI_PROJECT_SCHEMA),
  nextToken: v.nullable(v.string()),
});
