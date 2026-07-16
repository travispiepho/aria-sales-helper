# Native iOS Companion (Phase 6 Placeholder)

This directory is reserved for the **SwiftUI native iOS app** that will be built in Phase 6.

## Purpose
- ARKit/RoomPlan LiDAR measurements
- Deep-linked from the PWA via `sorterpro://measure?meeting_id=...`
- TestFlight distribution

## Requirements
- iOS 16+, LiDAR-capable devices (iPhone 12 Pro and later Pro models only)
- Apple Developer Program account ($99/yr) — flag to client before Phase 6

## Phase 6 Deliverables (not built yet)
- Quick Measure mode: ARKit raycast point-to-point distance
- Room Scan mode: Apple RoomPlan API → USDZ floor plan export
- On save: POST /api/measurements (same auth as PWA)
- Universal link back to PWA meeting screen after measurement

## Status
**Not built. Placeholder only. Do not start Phase 6 until Phases 1–5 are complete and client has Apple Developer account.**
