/* D-049：可离线重放的建议输入。只消费显式封存事实；不读数据库、网络或时钟。 */
'use strict';
const crypto = require('node:crypto');
const Domain = require('../js/domain');
const ALGORITHM_VERSION = 'cash-reallocation-v1';
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
function reject(code, message) { throw Object.assign(new Error(message || code), { code }); }
function checked(result) { if (!result.ok) reject(result.error.code, result.error.detail); return result; }
function calculate(input) {
  if (!input || input.algorithmVersion !== ALGORITHM_VERSION) reject('invalid_recommendation_record', '缺少可重放的建议输入或算法版本不可用');
  const { request: body, assets, settings, riskAssessments, allocationTargets, approvedInstruments, close, snapshot: snap, asOf: today } = input;
  checked(Domain.validateRecommendationRequest(body));

  const snapRef = body.snapshotRef;
  if (!snap || snap.id !== snapRef.snapshotId || snap.closeId !== snapRef.closeId) reject('unknown_snapshot', '引用的结账快照在本机不存在');
  if (!close || close.id !== snap.closeId) reject('unknown_close', '引用的月结不存在');
  const checks = [];
  const gate = (code, passed, detail = '') => checks.push({ code, passed: passed === true, detail });
  const currentSnapshot = !!(close.snapshot && close.snapshot.id === snap.id && close.dataCutoff);
  gate('snapshot_ref', currentSnapshot, currentSnapshot ? '' : 'snapshot_not_current');
  gate('close_formal', close.status === 'formal', close.status === 'formal' ? '' : 'close_incomplete');
  const rawHash = crypto.createHash('sha256').update(snap.payloadJson).digest('hex');
  const hashOk = rawHash === snap.payloadHash && snap.payloadHash === snapRef.payloadHash;
  gate('snapshot_hash', hashOk, hashOk ? '' : 'snapshot_hash_mismatch');
  const overview = Domain.computeOverview(assets, { now: today, settings });
  gate('can_advise', overview.canAdvise === true, overview.canAdvise ? '' : 'valuation_not_formal');
  const sel = checked(Domain.selectCurrentAssessment(riskAssessments, today));
  const referenced = riskAssessments.find(a => a.id === body.assessmentRef.id);
  if (!referenced) reject('unknown_assessment', '引用的风险评估不存在');
  const assessment = checked(Domain.validateRiskAssessmentRecord(referenced)).record;
  const isCurrent = sel.status === 'current' && sel.current.record.id === assessment.id;
  gate('assessment_valid', isCurrent, isCurrent ? '' : sel.status === 'all_expired' ? 'assessment_expired' : 'assessment_not_current');
  const tsel = checked(Domain.selectCurrentTarget(allocationTargets, assessment, today));
  if (tsel.status !== 'current') reject('no_target', '该评估还没有可用的目标版本');
  const target = checked(Domain.validateAllocationTargetRecord(tsel.current.target, assessment)).record;
  const targetMatches = target.templateVersion === body.targetVersion && target.ruleVersion === body.ruleVersion;
  if (!targetMatches) reject('target_assessment_mismatch', '目标与评估或模板版本不匹配');
  gate('target_matches_assessment', true);
  const available = overview.newFundsAvailableMinor;
  gate('new_funds_within_available', body.newFundsMinor <= available, body.newFundsMinor <= available ? '' : 'new_funds_exceeds_available');
  const folded = checked(Domain.recommendationStatusFromGate(checks));
  const deviation = checked(Domain.computeAllocationDeviation(target, overview));
  const allocation = checked(Domain.computeNewFundsAllocation({target, deviation, requestedNewFundsMinor: body.newFundsMinor, newFundsAvailableMinor: available})).allocation;
  const mapping = checked(Domain.checkApprovedMapping(approvedInstruments, assets.instruments));
  const mapped = checked(Domain.mapAllocationToApprovedInstruments(allocation, mapping));
  const gateBlockers = [];
  folded.checks.forEach(c => {
    if (c.passed || c.code === 'can_advise') return;
    const code = c.detail || c.code;
    if (!overview.blockers.some(b => b.code === code) && !gateBlockers.some(b => b.code === code)) gateBlockers.push({code, detail:c.code});
  });
  const versions = {ruleVersion: Domain.RISK_RULE_VERSION, targetVersion: target.templateVersion, targetLevel:target.level,
    assessmentId:assessment.id, targetId:target.id, closeId:close.id, snapshotId:snap.id, snapshotPayloadHash:snap.payloadHash,
    dataCutoff:close.dataCutoff, asOf:today};
  const built = checked(Domain.buildRecommendationResult({status:folded.status, blockers:overview.blockers.concat(gateBlockers),
    dataCutoff:close.dataCutoff, versions, deviation, allocation, mapping:mapped}));
  return { status:folded.status, versions, allocation, checks:folded.checks, todos:built.todos, result:built.result };
}
// 输入集合以字段内容排序；业务顺序由 position/日期/id 表达，不依赖数据库返回行序。
function normalizeInput(value) {
  const out = JSON.parse(JSON.stringify(value));
  const sort = rows => rows.sort((a,b) => {
    const aa = canonicalJson(a), bb = canonicalJson(b); return aa < bb ? -1 : aa > bb ? 1 : 0;
  });
  for (const key of ['riskAssessments','allocationTargets','approvedInstruments']) if (Array.isArray(out[key])) sort(out[key]);
  for (const key of Object.keys(out.assets || {})) if (Array.isArray(out.assets[key])) sort(out.assets[key]);
  return out;
}
module.exports = { ALGORITHM_VERSION, canonicalJson, hash, calculate, normalizeInput };
