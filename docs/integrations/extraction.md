# Receipt extraction providers

`EXTRACTOR` selects the provider:

| Value | Reads pixels | Needs | Notes |
|---|---|---|---|
| `tesseract` (default) | yes, offline OCR | nothing (model data bundled) | used by the suites and the seed; ~0.6 s p50 per receipt here |
| `anthropic` | yes, vision model | `ANTHROPIC_API_KEY` (`ANTHROPIC_MODEL` default claude-sonnet-5) | forced tool call returns structured facts; prompt version recorded |
| `anthropic+tesseract` | yes, both | key | cross-checked; disagreements on number/date/total become review reasons |
| `simulator` | **no** | local/test only | reads text embedded in test images; refused elsewhere |

All providers feed the same parser and rule engine; the image is validated and normalised first (`media/images.ts`). Health and mode are shown in Ops → Health and in the readiness report. `EXTRACTION_TIMEOUT_MS` bounds a single attempt; transient failures leave the submission `delayed` with a scheduled retry and a participant notice.
