# Reference documents

Four PDFs and the sources they are generated from.

| Document | For |
|---|---|
| `Court-Call-Technical-Reference.pdf` | Engineers. Architecture, pairing engine, data model, access control, integrity, operating notes |
| `Court-Call-Decision-Record.pdf` | Why things are the way they are, with the cost of each decision stated |
| `Court-Call-Workflow.pdf` | How a week runs; what resets and what persists |
| `Court-Call-User-Guide.pdf` | Club members |

Regenerate after editing the HTML:

```
pip install weasyprint
weasyprint technical.html  Court-Call-Technical-Reference.pdf
weasyprint decisions.html  Court-Call-Decision-Record.pdf
weasyprint workflow.html   Court-Call-Workflow.pdf
weasyprint userguide.html  Court-Call-User-Guide.pdf
```

These were current at **v0.70.0** and have drifted since. Still accurate: architecture,
the data model, access control, retention, and the scoring weights. Out of date: ratings
moved behind a tap on the info control, the standings table was removed from History,
watching another browser's sheet, session-date stamping, and sharing the sheet as an
image. `CLAUDE.md` at the repo root is current.
