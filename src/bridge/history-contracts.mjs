const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const attachment = object({ attachmentId: string, filename: string, totalBytes: integer, revision: string, declaredBytes: integer,
  preservationStatus: { enum: ['declared-size-matched', 'declared-representation-unverified'] } });
const history = { historyId: string, topicId: { type: ['string', 'null'] }, title: string, totalMessages: integer, readOnly: { const: true } };
const schemas = {
  'command-center.v1.histories.list': object({ schemaVersion: { const: 1 }, histories: { type: 'array', items: object(history) } }),
  'command-center.v1.histories.read': object({ schemaVersion: { const: 1 }, ...history,
    messages: { type: 'array', items: object({ messageId: string, author: string, bot: boolean, timestamp: string, text: string, detailsJson: string,
      attachments: { type: 'array', items: attachment } }) }, offset: integer, nextOffset: { type: ['integer', 'null'] }, hasMore: boolean }),
  'command-center.v1.histories.attachment-read': object({ schemaVersion: { const: 1 }, historyId: string, messageId: string,
    ...attachment.properties, byteOffset: integer, contentBase64: string, nextOffset: integer, complete: boolean })
};
export const historyResultSchema = method => schemas[method];
