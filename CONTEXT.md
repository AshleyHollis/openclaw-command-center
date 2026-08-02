# Command Center

Vocabulary for the OpenClaw plugin that provides a global attention surface and focused PARA contexts inside the Control UI.

## Navigation and context

**Command Center**:
The full-size personal command-centre interface provided inside OpenClaw's Control UI.
_Avoid_: standalone app, sidebar dashboard

**Global Dashboard**:
The pull-based overview whose primary content is the attention inbox and whose secondary content includes upcoming items, global activity, and Space navigation.
_Avoid_: activity feed, notification feed

**PARA Category**:
The user-selected classification of a Space as Project, Area, Resource, or Archive.

**Space**:
A durable PARA context boundary for one domain or topic, with one dedicated Note Folder, one Primary Session, and any number of Space Conversations. Its identity persists across renaming, PARA recategorization, Note Folder relocation, Primary Session replacement, archiving, and restoration.
_Avoid_: channel, domain, folder, session

**Provisioning Space**:
A reserved Space identity whose conventional Note Folder and Primary Session have not both been bound. It is recoverable but not yet usable as a Space.
_Avoid_: partial Space, broken Space

**Archived Space**:
A reversible, read-only Space whose PARA Category is Archive. It retains its identity, history, and searchability until restored to another PARA Category.
_Avoid_: Retired Space, deleted Space

**Retired Space**:
A terminal provenance record for a Space absorbed by a merge or dissolved by a split. It retains identity and lineage but owns no active context and cannot be restored directly.
_Avoid_: Archived Space, deleted Space

**Space Lineage**:
The recorded predecessor-and-successor relationship created by a Space merge or split. It keeps historical links and provenance resolvable across topology changes.

**Space Page**:
The focused Command Center destination for one Space, combining its Chat, Notes, search, and later Space-specific detail.
_Avoid_: channel page

## Knowledge and conversation

**Note**:
A durable knowledge document whose authoritative content lives in the user's Obsidian vault and belongs to exactly one Space through its Note Folder. OpenClaw may create, update, or freely rewrite it without per-write approval.

**Note Folder**:
The single Obsidian folder that forms the authoritative boundary for a Space's Notes.

**Primary Session**:
The replaceable Space Conversation that receives messages sent through a Space's main Chat. A former Primary remains linked as an ordinary Space Conversation; migrated history forms an immutable prefix of the initial Primary Session.

**Space Conversation**:
An isolated OpenClaw session associated with exactly one Space at a time. Reassignment preserves its identity, transcript, and originating-Space provenance without inheriting another Space Conversation's transcript.

**Closed Conversation**:
A read-only Space Conversation omitted from active Chat defaults while remaining searchable and reopenable. A Primary Session must be replaced before it can be closed.
_Avoid_: Archived Conversation, deleted Conversation

**Space Search**:
A search across a Space's Notes and Space Conversations, including migrated history in its Primary Session, whose results identify their authoritative source.

**Space Review**:
Periodic analysis that identifies when recurring topics or misplaced context suggest a better Space boundary. Structural changes are proposed through a gated Action Card rather than performed silently.
_Avoid_: Space Gardening, gardening

## Lifecycle and structure

**Convention-managed Source**:
A Note Folder name, location, or Session display label that follows the Space creation convention until explicitly customized. Confirmed Space renames and recategorizations update it without changing source identity.

**Source Recovery**:
The visible condition in which a Space retains its identity while a referenced Note Folder or Session cannot be resolved safely. Dependent writes remain blocked until the source is verified and relinked, restored, or explicitly replaced.
_Avoid_: automatic repair, inferred rebinding

**Structural Change**:
A confirmed change to Space classification, source ownership, Primary Session selection, archival state, or merge-and-split topology. Agent-proposed Structural Changes require a gated Action Card; direct user actions receive an immediate preview and confirmation.
_Avoid_: maintenance, background cleanup

## Attention and activity

**Attention Item**:
A deduplicated representation of something that currently requires the user's attention, including an operational condition or due Reminder.
_Avoid_: notification, activity

**Action Card**:
The Global Dashboard presentation of an Attention Item, exposing source-appropriate actions and navigation.

**OpenClaw Activity**:
An execution or operational record produced by OpenClaw and presented globally. It becomes an Attention Item only when user action is required.
_Avoid_: Space task, To-do

**Reminder**:
A lightweight commitment associated with a Space and scheduled through OpenClaw's internal scheduler. It becomes an Attention Item when due.
_Avoid_: Workboard item, OpenClaw Task
