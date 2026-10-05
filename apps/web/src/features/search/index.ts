/**
 * @cytale/web — search surface (U24).
 */
export { SearchPeople, type SearchPeopleProps } from './SearchPeople.js';
export { useSearch, type UseSearch, type UseSearchOptions, type SearchStatus } from './useSearch.js';
export { parseSearchQuery, type ParsedSearch } from './query.js';
export { fetchSearchPage, type SearchHit, type SearchPage, type SearchQuery, type SearchApiError } from './api.js';
