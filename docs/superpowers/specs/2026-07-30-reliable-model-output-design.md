# Reliable 2, 4, and 6 track output design

**Date** 2026-07-30

**Status** Approved by the request to address blank tracks

## Goal

Every split uses the uploaded audio as its source and the selected model only as
an output contract. No runtime path or full-pipeline smoke test selects a
particular song. A finished job contains exactly the named tracks promised by
the selected 2, 4, or 6 track choice, and every stored result is a non-empty MP3.

## Output contracts

- The 2 track choice returns vocals and instrumental.
- The 4 track choice returns vocals, drums, bass, and other.
- The 6 track choice returns vocals, drums, bass, other, guitar, and piano.
- The order of provider fields does not matter.
- Missing, repeated, or unexpected track names fail the job before any channel
  reaches the mixer.

The contract describes the output names. It never depends on the filename,
title, artist, genre, or source URL.

## Audio validation

The Worker downloads each provider result and verifies that the body is not
empty and contains an MP3 header or frame. A malformed result is retried three
times. If it remains invalid, the job fails with the affected track named and
any partial files from that ingestion attempt are removed.

A valid but quiet track is different from a blank file. Six-track separation
can produce a quiet guitar or piano track when the source does not contain that
instrument. The app must not call a quiet but valid MP3 a transport failure.

## Frontend

The Worker supplies the available choices, direct labels, and expected track
names. The browser builds the choice controls from that response instead of
duplicating model identifiers and descriptions in the page.

The labels state the tracks produced without making a vague quality claim.

Processing rows use the expected names supplied with the job. Finished rows use
only the stored results returned by the job endpoint. A finished response with
no playable tracks is shown as an error rather than as an empty mixer.

## Testing

Table-driven contract tests cover all three models with generic source data.
Browser and Worker tests verify the direct model labels, exact track counts,
missing six-track output, empty MP3 output, partial-file cleanup, playback, and
the absence of blank ready channels.

The paid smoke workflow requires a caller-supplied YouTube URL. It contains no
default song.
