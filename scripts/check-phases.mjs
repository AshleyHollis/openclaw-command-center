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
