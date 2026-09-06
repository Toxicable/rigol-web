# Scope numeric input commit semantics

Scope-side numeric fields are draftable text inputs. Editing is local until blur or Enter; Escape cancels; empty or invalid drafts restore the authoritative value. This is intentional so backspace/select-all/retype does not send intermediate SCPI values. Display text is rounded to six significant digits while the committed numeric value remains a normal finite JavaScript number.

Incremental cost: **$0**.
