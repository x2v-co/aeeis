import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ResourceRef, ResourceSelection, ResourceSnapshot } from './contracts.js';

/** A small, immutable registry boundary for Plugin/Skill/Workflow releases.
 * The registry owns the digest: callers may request a release, but cannot
 * make an arbitrary digest valid. A remote registry can implement this same
 * interface and add signature/SBOM verification before returning a manifest. */
export const resourceKindSchema = z.enum(['plugin', 'skill', 'workflow', 'tool']);
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export const resourceManifestSchema = z.object({
  releaseId: z.string().trim().min(1).max(200),
  kind: resourceKindSchema,
  id: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(100),
  interface: z.string().trim().min(1).max(100),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  channel: z.enum(['dev', 'canary', 'beta', 'stable']),
  status: z.enum(['published', 'revoked']).default('published'),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  signature: z.string().min(1).max(10000).optional(),
  sbomDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type ResourceManifest = z.infer<typeof resourceManifestSchema>;

export interface ResourceResolution {
  selection: ResourceSelection;
  registryRevision: string;
}

export interface ResourceRegistry {
  resolve(input: { resources?: ResourceSelection; builtinSkill?: string }): Promise<ResourceResolution>;
  verify(snapshot: ResourceSnapshot): Promise<void>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)]));
  return value;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function key(kind: ResourceKind, ref: Pick<ResourceRef, 'id' | 'version'>): string { return `${kind}:${ref.id}@${ref.version}`; }
function semver(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
function satisfies(version: string, range?: string): boolean {
  if (!range || range === '*' || range === 'latest') return true;
  const actual = semver(version); if (!actual) return version === range;
  const exact = semver(range); if (exact) return actual.every((part, index) => part === exact[index]);
  const prefix = /^(\^|~)\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range);
  if (prefix) {
    const base: [number, number, number] = [Number(prefix[2]), Number(prefix[3]), Number(prefix[4] ?? 0)];
    if (actual[0] !== base[0] || compareSemver(actual, base) < 0) return false;
    return prefix[1] === '^' ? (base[0] > 0 || actual[1] === base[1]) : actual[1] === base[1];
  }
  return false;
}
function refFromManifest(manifest: ResourceManifest): ResourceRef {
  return { id: manifest.id, version: manifest.version, interface: manifest.interface, digest: manifest.digest, channel: manifest.channel, releaseId: manifest.releaseId };
}

/** In-memory registry used by the API and tests. It intentionally rejects
 * duplicate id/version releases with different digests. Promotion changes the
 * revision/pointers in the registry, while existing Run snapshots continue to
 * verify against their immutable release digest. */
export class InMemoryResourceRegistry implements ResourceRegistry {
  private readonly byKey = new Map<string, ResourceManifest>();
  private readonly revisionValue: string;
  constructor(manifests: ResourceManifest[], revision = '1') {
    for (const raw of manifests) {
      const manifest = resourceManifestSchema.parse(raw);
      const manifestKey = key(manifest.kind, manifest);
      const previous = this.byKey.get(manifestKey);
      if (previous && previous.digest !== manifest.digest) throw new Error(`Resource ${manifestKey} has multiple digests`);
      this.byKey.set(manifestKey, manifest);
    }
    this.revisionValue = revision;
  }
  get revision(): string { return this.revisionValue; }
  private find(kind: ResourceKind, ref: ResourceRef): ResourceManifest {
    const exact = this.byKey.get(key(kind, ref));
    const manifest = exact ?? [...this.byKey.values()].filter(candidate => candidate.kind === kind && candidate.id === ref.id && candidate.interface === ref.interface && satisfies(candidate.version, ref.range)).sort((a, b) => (semver(b.version)?.[0] ?? 0) - (semver(a.version)?.[0] ?? 0) || (semver(b.version)?.[1] ?? 0) - (semver(a.version)?.[1] ?? 0) || (semver(b.version)?.[2] ?? 0) - (semver(a.version)?.[2] ?? 0))[0];
    if (!manifest || (ref.range ? !satisfies(manifest.version, ref.range) : manifest.version !== ref.version) || manifest.digest !== ref.digest && !ref.range || manifest.interface !== ref.interface || (ref.channel && manifest.channel !== ref.channel) || (ref.releaseId && manifest.releaseId !== ref.releaseId)) {
      throw new Error(`Resource ${kind} ${ref.id}@${ref.version} does not match the Registry manifest`);
    }
    if (manifest.status === 'revoked') throw new Error(`Resource ${kind} ${ref.id}@${ref.version} is revoked`);
    return manifest;
  }
  async resolve(input: { resources?: ResourceSelection; builtinSkill?: string }): Promise<ResourceResolution> {
    const requested = input.resources;
    const selection: ResourceSelection = {};
    const checks: Array<[ResourceKind, ResourceRef | undefined]> = [
      ['plugin', requested?.plugin], ['skill', requested?.skill], ['workflow', requested?.workflow],
    ];
    for (const [kind, ref] of checks) if (ref) (selection as any)[kind] = refFromManifest(this.find(kind, ref));
    if (requested?.tools) selection.tools = requested.tools.map(ref => refFromManifest(this.find('tool', ref)));
    return { selection, registryRevision: this.revisionValue };
  }
  async verify(snapshot: ResourceSnapshot): Promise<void> {
    for (const [kind, ref] of [['plugin', snapshot.plugin], ['skill', snapshot.skill], ['workflow', snapshot.workflow]] as Array<[ResourceKind, ResourceRef | undefined]>) if (ref) {
      // Built-in output contracts are compiled into AEEIS and are verified by
      // the runtime implementation digest. A Registry may omit these internal
      // records; if it publishes one, revocation/drift is still enforced.
      const hasPublishedBuiltin = [...this.byKey.values()].some(candidate => candidate.kind === kind && candidate.id === ref.id && candidate.interface === ref.interface);
      const builtin = kind === 'skill' && (ref.id === 'website-builder' || ref.id === 'project-pulse') && !hasPublishedBuiltin;
      if (!builtin) this.find(kind, ref);
    }
    // Toolkit tool versions are already verified against the Toolkit manifest
    // digest by AgentEngine. Only tool refs explicitly resolved by this
    // Registry carry a releaseId and need this second Registry check.
    for (const ref of snapshot.tools ?? []) if (ref.releaseId) this.find('tool', ref);
  }
  revoke(releaseId: string): void {
    for (const [manifestKey, manifest] of this.byKey) if (manifest.releaseId === releaseId) this.byKey.set(manifestKey, { ...manifest, status: 'revoked' });
  }
}

export interface ResourceRegistryFile { schemaVersion: 'resource-registry/1'; revision: string; manifests: ResourceManifest[] }

export class FileResourceRegistry extends InMemoryResourceRegistry {
  static async load(path: string): Promise<FileResourceRegistry> {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const file = z.object({ schemaVersion: z.literal('resource-registry/1'), revision: z.string().min(1), manifests: z.array(resourceManifestSchema) }).strict().parse(parsed);
    return new FileResourceRegistry(file.manifests, file.revision);
  }
}
