# Message block demo

Reference implementation of `app.slots.experimental_messageBlock`. It claims
`:::demo-card` blocks in assistant messages and draws them as a card with one
section per heading.

- `card.ts` is the pure codec: `parse` groups bb's mdast tree by heading and
  slices each section's markdown out of the block's text by node position;
  `toText` turns the data back into plain text.
- `app.tsx` registers the codec with a component that validates `data`
  (it is model output), renders each section with `<Markdown>`, and shows
  bb's literal block through `Original` when the reader asks for the source.

See `docs/api_to_audit.md` for the surface's experimental status.
