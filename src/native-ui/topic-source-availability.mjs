export const topicSourceAvailable = (topic, sourceKind) =>
  !topic?.recovery?.some(item => item?.state === 'required' && item?.sourceKind === sourceKind);
