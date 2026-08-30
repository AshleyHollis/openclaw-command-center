const PREFIX = /^(Archive|Project|Area|Resource):\s*(.+)$/iu;
const CATEGORIES = Object.freeze({ project: 'project', area: 'area', resource: 'resource' });

// A deliberately conservative production analyzer. It treats an explicit PARA
// prefix in the authoritative Topic name as user-authored structural evidence;
// it never infers from inactivity, private content, or an opaque score.
export function createProductionTopicAnalyzer() {
  return async function analyze({ topic, sources = [] } = {}) {
    const match = typeof topic?.name === 'string' ? PREFIX.exec(topic.name.trim()) : null;
    const source = sources.find((item) => typeof item?.referenceId === 'string' && typeof item?.observedRevision === 'string');
    if (!match || !source) return [];
    const directive = match[1].toLowerCase();
    let operation; let paraCategory;
    if (directive === 'archive' && topic.paraCategory !== 'archive') operation = 'archive', paraCategory = 'archive';
    else if (directive in CATEGORIES && topic.paraCategory === 'archive') operation = 'restore', paraCategory = CATEGORIES[directive];
    else if (directive in CATEGORIES && topic.paraCategory !== CATEGORIES[directive] && topic.paraCategory !== 'archive') operation = 'recategorize', paraCategory = CATEGORIES[directive];
    else return [];
    return [{
      operation,
      topic,
      affectedTopicIds: [topic.topicId],
      affectedSourceIds: [source.referenceId],
      plannedSourceIds: [],
      before: { topicId: topic.topicId, name: topic.name, paraCategory: topic.paraCategory, lifecycle: topic.lifecycle, revision: topic.revision },
      after: { topicId: topic.topicId, name: topic.name, paraCategory, lifecycle: topic.lifecycle, revision: topic.revision + 1 },
      rationale: `The explicit ${match[1]} Topic-name directive requests this structural change.`,
      evidenceFacts: [{ sourceId: source.referenceId, sourceRevision: source.observedRevision, fact: `The authoritative Topic name begins with the explicit ${match[1]} structural directive.`, material: true, kind: 'explicit-topic-directive' }],
      provenance: { provider: 'command-center-explicit-topic-directive', topicRevision: String(topic.revision), sourceId: source.referenceId, sourceRevision: source.observedRevision },
      searchRetrievalConsequences: operation === 'archive' ? { history: 'retained', visibility: 'archived Topic remains searchable' } : { identity: 'unchanged', category: paraCategory, history: 'retained' },
      dependencies: [], blockers: [], reversibility: { reversible: true, irreversible: false, ambiguity: null }
    }];
  };
}
