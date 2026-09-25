/** Contract verifier utilities; not imported by AEEIS runtime. */
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';

export const canonical = value => canonicalize(value);
export const digestBytes = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const digestValue = value => digestBytes(Buffer.from(canonical(value), 'utf8'));
export function catalogDigest(catalog) {
  const { digest, signature, ...payload } = catalog;
  return digestValue(payload);
}
/** Digest of the exact offering candidate set persisted in an AEEIS Model Pin. */
export function offeringHash(offering) {
  return digestValue({
    offeringId: offering.offeringId,
    modelId: offering.modelId,
    modelVersion: offering.modelVersion,
    versionStatus: offering.versionStatus,
    providerId: offering.providerId,
    channelId: offering.channelId,
    regionSetId: offering.regionSetId,
    pricingVariantId: offering.pricingVariantId,
    pricing: offering.pricing,
  });
}
export function candidateSetHash(candidates) {
  const projected = candidates.map(offering => ({
    offeringId: offering.offeringId,
    offeringHash: offeringHash(offering),
  })).sort((a, b) => a.offeringId.localeCompare(b.offeringId));
  check(projected.every((value, index) => index === 0 || projected[index - 1].offeringId < value.offeringId), 'candidate_ids_not_sorted_unique');
  return digestValue({ schemaVersion: 'aeeis-candidate-set/1', candidates: projected });
}
export function fraction(text) {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{0,17}[1-9])?$/.test(text)) throw new Error('noncanonical_decimal');
  const [whole, fractional = ''] = text.split('.');
  return [BigInt(whole + fractional), 10n ** BigInt(fractional.length)];
}
export function usdUnitPrice(source, rate) {
  if (source === null || rate === null) return null;
  const [n, d] = fraction(source);
  const [rn, rd] = fraction(rate);
  if (rn === 0n) throw new Error('zero_fx_rate');
  const numerator = n * rd * 100000000n;
  const denominator = d * rn;
  let q = numerator / denominator;
  const r = numerator % denominator;
  if (r * 2n > denominator || (r * 2n === denominator && q % 2n === 1n)) q++;
  const s = q.toString().padStart(9, '0');
  return (s.slice(0, -8) + '.' + s.slice(-8)).replace(/\.?0+$/, match => match.startsWith('.') ? '' : match).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
const check = (c, reason) => { if (!c) throw new Error(reason); };
const validTime = t => Number.isFinite(Date.parse(t));
const interval = (start, end) => check(validTime(start) && validTime(end) && Date.parse(start) < Date.parse(end), 'invalid_interval');
const sortedUnique = list => list.every((v,i) => i === 0 || list[i-1] < v);
const decimalPositive = text => fraction(text)[0] > 0n;
const decimalAtMostOne = text => {
  const [n, d] = fraction(text);
  return n <= d;
};
export function conditionsSemantics(condition, pricingCurrency, depth = 0) {
  check(condition && condition.schemaVersion === 'pricing-conditions/1', 'conditions_schema_version');
  check(depth <= 3, 'conditions_max_depth');
  switch (condition.kind) {
    case 'standard':
      check(Object.keys(condition).length === 2, 'standard_conditions_extra_fields');
      return;
    case 'tier': {
      check(condition.tiers.length > 0, 'tier_empty');
      let previous = 0;
      for (let i = 0; i < condition.tiers.length; i += 1) {
        const tier = condition.tiers[i];
        check(tier.upToUnits === null ? i === condition.tiers.length - 1 : tier.upToUnits > previous, 'tier_bounds_not_strict');
        check(tier.upToUnits === null || Number.isInteger(tier.upToUnits), 'tier_bound_not_integer');
        check(tier.upToUnits === null || tier.upToUnits > 0, 'tier_bound_not_positive');
        check(tier.upToUnits === null || (previous = tier.upToUnits), 'tier_bound_assignment');
        fraction(tier.unitPrice);
      }
      return;
    }
    case 'cache':
      check(Number.isInteger(condition.ttlSeconds) && condition.ttlSeconds >= 0, 'cache_ttl_invalid');
      return;
    case 'reasoning':
      check(decimalPositive(condition.multiplier), 'reasoning_multiplier_invalid');
      return;
    case 'minimum_spend':
      check(condition.currency === pricingCurrency, 'minimum_spend_currency_mismatch');
      check(decimalPositive(condition.amount), 'minimum_spend_amount_invalid');
      return;
    case 'batch':
      check(decimalPositive(condition.discountMultiplier) && decimalAtMostOne(condition.discountMultiplier), 'batch_discount_invalid');
      return;
    case 'composite':
      check(condition.conditions.length > 0, 'composite_empty');
      for (const nested of condition.conditions) conditionsSemantics(nested, pricingCurrency, depth + 1);
      return;
    default:
      throw new Error('conditions_kind_unknown');
  }
}
export function pricingSemantics(p) {
  interval(p.effectiveAt, p.expiresAt);
  const ids = p.components.map(c => c.componentId);
  check(sortedUnique(ids), 'components_not_sorted_unique');
  check(p.components.every(c => c.currency === p.currency), 'mixed_currency');
  const n = p.normalization;
  check(JSON.stringify(Object.keys(n.componentPrices).sort()) === JSON.stringify([...ids].sort()), 'normalization_component_keys');
  const source = new URL(p.provenance.sourceUrl);
  check(source.protocol === 'https:' && !source.username && !source.password && !source.search && !source.hash, 'unsafe_provenance_url');
  if (n.fx) {
    interval(n.fx.asOf, n.fx.expiresAt);
    check(n.fx.base === 'USD' && n.fx.quote === p.currency && n.fx.direction === 'quote_per_base', 'fx_currency_direction');
    check(fraction(n.fx.rate)[0] > 0n, 'nonpositive_rate');
    if (p.currency === 'USD') check(n.fx.rate === '1' && n.fx.sourceId === 'identity' && n.fx.asOf === p.effectiveAt && n.fx.expiresAt === p.expiresAt, 'invalid_identity_fx');
  }
  for (const c of p.components) {
    conditionsSemantics(c.conditions, p.currency);
    const amount = c.unit === 'token' ? c.pricePerMillion : c.unitPrice;
    check(n.componentPrices[c.componentId] === usdUnitPrice(amount,n.fx?.rate ?? null), 'incorrect_normalization');
  }
  const allKnown = n.fx !== null && p.components.every(c => c.priceStatus === 'known');
  check(n.status === (allKnown ? 'available' : 'unavailable'), 'normalization_status');
}
export function catalogSemantics(c) {
  interval(c.effectiveAt,c.expiresAt);
  check(Date.parse(c.generatedAt) <= Date.parse(c.effectiveAt),'generated_after_effective');
  check(sortedUnique(c.offerings.map(o=>o.offeringId)), 'offerings_not_sorted_unique');
  const tuples = new Set();
  for(const o of c.offerings) {
    const tuple = JSON.stringify([o.modelId,o.modelVersion,o.providerId,o.channelId,o.regionSetId,o.pricingVariantId]);
    check(!tuples.has(tuple),'duplicate_identity_tuple'); tuples.add(tuple);
    check(sortedUnique(o.capabilities) && sortedUnique(o.regions), 'tags_not_sorted_unique');
    pricingSemantics(o.pricing);
  }
  check(c.digest === catalogDigest(c),'catalog_digest_mismatch');
}
export function fxSemantics(fx) {
  const seen = new Set();
  for(const q of fx.quotes) {
    check(!seen.has(q.quote),'duplicate_fx_quote'); seen.add(q.quote);
    interval(q.asOf,q.expiresAt);
    check(fraction(q.rate)[0]>0n,'nonpositive_rate');
    check(Date.parse(q.asOf) <= Date.parse(fx.generatedAt) && Date.parse(fx.generatedAt)<Date.parse(q.expiresAt),'fx_not_fresh_at_publication');
  }
}
export function healthSemantics(h) {
  if(h.status==='alive') return;
  if(h.status==='ready') {
    check(Date.parse(h.checkedAt)<Date.parse(h.catalog.expiresAt),'ready_expired');
  } else {
    check(h.database.ready === (h.reason!=='database_unavailable'),'database_reason_mismatch');
    if(h.reason==='catalog_missing') check(h.catalog.catalogVersion===null && h.catalog.expiresAt===null,'missing_catalog_metadata');
    if(h.reason==='catalog_expired') check(h.catalog.catalogVersion!==null && Date.parse(h.checkedAt)>=Date.parse(h.catalog.expiresAt),'expiry_reason_mismatch');
  }
}
export function pinSemantics(pin, catalog, mapping, endpoint) {
  pricingSemantics(pin.pricingSnapshot);
  check(pin.resolvedEndpointHash===digestBytes(new URL(endpoint).href),'endpoint_hash_mismatch');
  if(pin.routingMode!=='catalog') return;
  const o = catalog.offerings.find(o=>o.offeringId===pin.offeringId);
  check(Boolean(o),'offering_missing');
  for(const k of ['modelId','modelVersion','versionStatus','providerId','channelId','regionSetId','pricingVariantId']) check(pin[k]===o[k],`pin_identity_${k}`);
  check(pin.catalogVersion===catalog.catalogVersion && pin.catalogDigest===catalog.digest,'pin_catalog_mismatch');
  check(Array.isArray(pin.candidateOfferings) && pin.candidateOfferings.length > 0, 'pin_candidate_set_missing');
  const candidates = pin.candidateOfferings.map(candidate => {
    const candidateOffering = catalog.offerings.find(value => value.offeringId === candidate.offeringId);
    check(candidateOffering, 'pin_candidate_offering_missing');
    check(candidate.offeringHash === offeringHash(candidateOffering), 'pin_candidate_offering_hash_mismatch');
    return candidateOffering;
  });
  check(candidates.some(candidate => candidate.offeringId === o.offeringId), 'pin_selected_offering_not_in_candidates');
  check(pin.catalogHash===candidateSetHash(candidates),'pin_candidate_set_hash_mismatch');
  check(canonical(pin.pricingSnapshot)===canonical(o.pricing),'pin_price_snapshot_mismatch');
  const m=mapping.mappings.find(m=>m.offeringId===pin.offeringId);
  check(m && pin.requestModel===m.requestModel && pin.endpointRef===m.endpointRef && pin.mappingVersion===mapping.mappingVersion,'pin_mapping_mismatch');
  check(Date.parse(pin.catalogRetrievedAt)<=Date.parse(pin.selectedAt),'pin_retrieval_time');
}
/** Only standard unconditional input/output token prices are executable in this draft. */
export function moneyBudgetDecision(catalog, offering, at) {
  const p=offering.pricing, n=p.normalization;
  const t=Date.parse(at);
  if(!Number.isFinite(t)) return 'reject_money_budget';
  const windows=[[catalog.effectiveAt,catalog.expiresAt],[p.effectiveAt,p.expiresAt],...(n.fx?[[n.fx.asOf,n.fx.expiresAt]]:[])];
  if(windows.some(([a,b])=>!(Date.parse(a)<=t && t<Date.parse(b)))) return 'reject_money_budget';
  if(offering.catalogStatus!=='available'||n.status!=='available'||!n.fx) return 'reject_money_budget';
  if(p.components.length!==2 || !['input','output'].every(kind=>p.components.some(c=>c.kind===kind&&c.unit==='token'&&c.priceStatus==='known'&&c.conditions?.schemaVersion==='pricing-conditions/1'&&c.conditions?.kind==='standard'))) return 'reject_money_budget';
  return 'allow_money_budget';
}
