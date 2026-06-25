# Architecture Decision Records

This directory records consequential, hard-to-reverse decisions: stack
choices, data model shape, identity/fingerprint strategy, filter language
design, subtitle modeling, and similar structural choices called out in
`AGENTS.md`.

## Process

1. Copy `0000-template.md` to `NNNN-short-title.md` using the next sequential
   number.
2. Fill in context, decision, alternatives, and consequences before or
   alongside the implementation — not after the fact.
3. Land the ADR in the same branch/PR as the change it justifies.
4. If a later decision reverses an earlier one, add a new ADR and mark the
   old one "superseded by ADR-NNNN" rather than editing history.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-stack-and-database-choice.md) | Stack and database choice | accepted |
| [0002](0002-core-schema-identity-and-hierarchy.md) | Core schema — identity, hierarchy, and ORM access | accepted |
