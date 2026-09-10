export function repositoryArtifactCheckPhases(purpose, { verifyBaseline, scanGenerated }) {
  if (!['qualification', 'capture-prerequisites'].includes(purpose)) throw new Error('Unsupported repository check purpose');
  if (typeof verifyBaseline !== 'function' || typeof scanGenerated !== 'function') throw new TypeError('Both artifact check owners are required');
  return [
    ...(purpose === 'qualification' ? [{ id: 'performance-baseline', run: verifyBaseline }] : []),
    { id: 'generated-artifact-safety', run: scanGenerated }
  ];
}

export async function runIndependentCheckPhases(phases) {
  if (!Array.isArray(phases) || phases.some((phase) => typeof phase?.id !== 'string' || typeof phase?.run !== 'function')) {
    throw new TypeError('check phases must have an id and run function');
  }
  const settled = await Promise.allSettled(phases.map((phase) => phase.run()));
  const failures = settled.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`${phases[index].id} phase failed`, { cause: result.reason })]
    : []);
  if (failures.length) throw new AggregateError(failures, 'Command Center check phases failed');
}
