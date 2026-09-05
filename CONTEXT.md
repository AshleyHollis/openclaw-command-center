# Command Center

Vocabulary for the OpenClaw plugin that provides a global attention surface and focused PARA Topics inside the Control UI.

## MVP delivery scope

The approved 2026-09-05 MVP is desktop-first (#19, #32). Basic desktop keyboard operation and all source-correctness, security, recovery, performance and safe-release requirements remain. Mobile-specific layout, touch and mobile zoom/reflow qualification is deferred, not passed (#216). Attachments (#213) and automatic Note maintenance (#214) remain follow-ups. See `docs/research/desktop-mvp-finish-plan.md` for the remaining work and evidence boundaries.

## Navigation and context

**Command Center**:
The full-size personal command-centre interface provided inside OpenClaw's Control UI.
_Avoid_: standalone app, sidebar dashboard

**Global Dashboard**:
The pull-based overview whose primary content is the attention inbox and whose secondary content includes upcoming items, global activity, and Topic navigation.
_Avoid_: activity feed, notification feed

**PARA Category**:
The user-selected classification of a Topic as Project, Area, Resource, or Archive.

**Topic**:
A durable PARA context boundary for one subject or purpose, with one dedicated Note Folder, one Primary Session, and any number of Topic Conversations. Its identity persists across renaming, PARA recategorization, Note Folder relocation, Primary Session replacement, archiving, and restoration.
_Avoid_: Space, Workspace, Hub, channel, domain, folder, session

**Provisioning Topic**:
A reserved Topic identity whose conventional Note Folder and Primary Session have not both been bound. It is recoverable but not yet usable as a Topic.
_Avoid_: partial Topic, broken Topic

**Archived Topic**:
A reversible, read-only Topic whose PARA Category is Archive. It retains its identity, history, and searchability until restored to another PARA Category.
_Avoid_: Retired Topic, deleted Topic

**Retired Topic**:
A terminal provenance record for a Topic absorbed by a merge or dissolved by a split. It retains identity and lineage but owns no active context and cannot be restored directly.
_Avoid_: Archived Topic, deleted Topic

**Topic Lineage**:
The recorded predecessor-and-successor relationship created by a Topic merge or split. It keeps historical links and provenance resolvable across topology changes.

**Topic Page**:
The focused Command Center destination for one Topic, combining its overview, Notes, search, and linked Conversations. Its Chat action opens the exact linked native OpenClaw conversation; Command Center does not own an active Chat composer or transcript renderer. Closed Conversations and Archived Topics retain a history-only source view because native Chat does not provide a read-only navigation contract.
_Avoid_: channel page

## Knowledge and conversation

**Note**:
A durable knowledge document whose authoritative content lives in the user's Obsidian vault and belongs to exactly one Topic through its Note Folder. OpenClaw may create, update, or freely rewrite it without per-write approval.

**Note Folder**:
The single Obsidian folder that forms the authoritative boundary for a Topic's Notes.

**Note Draft**:
Unsaved editing state for one exact Topic-owned Note. It retains the authoritative content revision on which editing began until a confirmed save or identity-preserving relocation advances that base. Opening another Note does not transfer the draft.
_Avoid_: authoritative Note, cached Note

**Source Locator**:
The verified current location of a source. Explicit Source Recovery may change a Session's locator without rewriting the durable Source Reference that identifies its Topic ownership and provenance.
_Avoid_: source identity

**Primary Session**:
The replaceable Topic Conversation selected by default for a Topic's native Chat action. A former Primary remains linked as an ordinary Topic Conversation; migrated history forms an immutable prefix of the initial Primary Session.

**Topic Conversation**:
An isolated OpenClaw session associated with exactly one Topic at a time. Reassignment preserves its identity, transcript, and originating-Topic provenance without inheriting another Topic Conversation's transcript.

**Closed Conversation**:
A read-only Topic Conversation omitted from active Chat defaults while remaining searchable and reopenable. A Primary Session must be replaced before it can be closed.
_Avoid_: Archived Conversation, deleted Conversation

**Topic Search**:
A search across a Topic's Notes and Topic Conversations, including migrated history in its Primary Session, whose results identify their authoritative source.

**Topic Analysis**:
The scheduled or manual background process that evaluates eligible Topics for potential Structural Changes. A quiet run creates an Activity Record only; decision-ready findings become proposals in Topic Review.
_Avoid_: Topic Review, Space Analysis, Space Gardening, gardening

**Topic Review**:
The single grouped Action Card through which the user reviews one or more Structural Change Proposals produced by Topic Analysis. The Topic Review is one Attention Item; its proposals are not separate Attention Items.
_Avoid_: Topic Analysis, Space Review, Space Gardening, gardening

## Lifecycle and structure

**Convention-managed Source**:
A Note Folder name, location, or Session display label that follows the Topic creation convention until explicitly customized. Confirmed Topic renames and recategorizations update it without changing source identity.

**Source Recovery**:
The visible condition in which a Topic retains its identity while a referenced Note Folder or Session cannot be resolved safely. Dependent writes remain blocked until the source is verified and relinked, restored, or explicitly replaced.
_Avoid_: automatic repair, inferred rebinding

**Structural Change**:
A confirmed change to Topic classification, source ownership, Primary Session selection, archival state, or merge-and-split topology. Agent-proposed Structural Changes require a gated Action Card; direct user actions receive an immediate preview and confirmation.
_Avoid_: maintenance, background cleanup

**Structural Change Proposal**:
A decision-ready recommendation produced by Topic Analysis for one exact Structural Change. Multiple independently decidable proposals may appear within one Topic Review.
_Avoid_: suggestion, recommendation, Attention Item, Action Card

## Attention and activity

**Attention**:
The user-facing Global Dashboard inbox of non-terminal Attention Items that currently require a decision or action.
_Avoid_: notifications, activity feed

**Attention Item**:
A deduplicated representation of something that currently requires the user's attention, including an operational condition or due Reminder.
_Avoid_: notification, activity

**Action Card**:
The Global Dashboard presentation of an Attention Item, exposing source-appropriate actions and navigation.

**Activity**:
The user-facing, read-only global history of Activity Records.
_Avoid_: Attention, notification feed, audit log

**Activity Record**:
One execution, maintenance, or outcome record presented in Activity. When its condition requires user action, Command Center creates or updates a separate Attention Item rather than making the Activity Record actionable.
_Avoid_: Topic task, To-do

**Reminder**:
A lightweight commitment associated with a Topic and scheduled through OpenClaw's internal scheduler. It becomes an Attention Item when due.
_Avoid_: Workboard item, OpenClaw Task
