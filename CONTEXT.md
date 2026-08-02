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
A durable PARA context boundary for one domain or topic, with one dedicated Note Folder, one Primary Session, and any number of Space Conversations.
_Avoid_: channel, domain, folder, session

**Space Page**:
The focused Command Center destination for one Space, combining its Chat, Notes, search, and later Space-specific detail.
_Avoid_: channel page

## Knowledge and conversation

**Note**:
A durable knowledge document whose authoritative content lives in the user's Obsidian vault. OpenClaw may create, update, or freely rewrite it without per-write approval.

**Note Folder**:
The single Obsidian folder that forms the authoritative boundary for a Space's Notes.

**Primary Session**:
The replaceable Space Conversation that receives messages sent through a Space's main Chat. A former Primary remains linked as an ordinary Space Conversation; migrated history forms an immutable prefix of the initial Primary Session.

**Space Conversation**:
An isolated OpenClaw session associated with a Space. It shares compact Space-level context and relevant Notes without inheriting another Space Conversation's transcript.

**Space Search**:
A search across a Space's Notes and Space Conversations, including migrated history in its Primary Session, whose results identify their authoritative source.

**Space Review**:
Periodic analysis that identifies when recurring topics or misplaced context suggest a better Space boundary. Structural changes are proposed through a gated Action Card rather than performed silently.
_Avoid_: Space Gardening, gardening

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
