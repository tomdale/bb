A reference plugin for message blocks. When an agent wraps part of its reply in a `:::demo-card` block, the plugin draws that part as a card with one section per heading.

## What you get

- A card in place of each `:::demo-card` block in an assistant message, with the text before the first heading as its lead and one labeled section per heading.
- A status label that reads "Writing…" while the block streams, "Complete" once the closer arrives, and "Unfinished" when the reply ends without one.
- A "Source" button that swaps the card for the block as bb shows it without the plugin: the marker lines with ordinary Markdown between them.
- The block's literal text, marker lines included, whenever bb cannot draw the card.

## How it works

The agent writes the block in its reply, with no space after the colons:

```text
:::demo-card{v="1"}
A short lead.

### Done
Tests pass.

### Next
Ship it.
:::
```

The block's contents are ordinary Markdown, so a fenced code block works inside it. The plugin registers `app.slots.experimental_messageBlock`. bb hands its `parse` step the text between the marker lines and bb's markdown tree of that text. The step groups the tree by heading and slices each section's markdown back out of the text by node position. The component renders each section with `<Markdown>`. A finished block with no heading fails to parse, so bb shows its literal text with a short note.

## Requirements

None. The plugin adds no agent tools, settings, or instructions, so agents only write a block when asked to. It is disabled by default.
