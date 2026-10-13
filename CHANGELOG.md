# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

### Added

- `EasySearch` with `search()`, `reload()`, `invalidate()` and `dispose()`.
- Data sources: arrays, sync/async functions and `DataProvider` objects; `DataLoadError` for failed loads.
- Search modes `exact`, `partial` and `fuzzy` (optimal string alignment distance, Hangul compared per jamo).
- Relevance scoring with per-field weights, stable ordering, `limit`, `filter`, `sort` and per-search `keys`.
- Typed dot-notation keys (`KeyPath<T>`), array traversal, automatic key discovery.
- Unicode handling: NFKC normalization, case folding, optional diacritic removal.
- Data lifecycle options: `reloadOnSearch`, `fallbackToStaleOnError`, `onError`, `idKey`.
- Optional LayerCache integration (`useLayerCache`, `cache`, `cacheKey`, `cacheTtl`) for loaded data and search results.
