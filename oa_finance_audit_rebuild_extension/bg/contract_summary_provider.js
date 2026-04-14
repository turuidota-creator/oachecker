import { deriveLocalContractSummary } from "./contract_terms.js";

export const CONTRACT_SUMMARY_PROVIDER = Object.freeze({
  id: "local_rules",
  label: "本地规则",
  mode: "offline_only"
});

export function buildContractSummaryProviderMeta(status, reason = "") {
  return {
    id: CONTRACT_SUMMARY_PROVIDER.id,
    label: CONTRACT_SUMMARY_PROVIDER.label,
    mode: CONTRACT_SUMMARY_PROVIDER.mode,
    status,
    reason
  };
}

export function generateContractSummary(clauseCandidates = [], baseFacts = {}) {
  const summary = deriveLocalContractSummary(clauseCandidates, baseFacts);
  return {
    ...summary,
    provider: buildContractSummaryProviderMeta(
      clauseCandidates.length > 0 ? "active" : "idle",
      clauseCandidates.length > 0 ? "已使用本地规则整理合同摘要与条款提醒" : "未筛到可用于摘要整理的合同条款候选"
    )
  };
}
