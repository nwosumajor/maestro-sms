// Polling System response DTOs (server form; Date fields are Date). NOTE: no DTO
// ever carries a voter→option mapping — anonymity is structural.

export interface PollOptionResultDto {
  id: string;
  label: string;
  /** Vote count for this option. Only populated when results are visible. */
  votes: number;
}

export interface PollDto {
  id: string;
  question: string;
  audience: string;
  status: string;
  createdById: string;
  createdByName: string;
  closesAt: Date | null;
  options: PollOptionResultDto[];
  /** Total votes cast (for percentages). */
  totalVotes: number;
  /** Whether the caller has already voted (NOT which option). */
  hasVoted: boolean;
  /** True when the caller may see per-option tallies (creator/staff, or a closed
   *  poll). Voters see results only after the poll closes — keeps live votes blind. */
  resultsVisible: boolean;
  createdAt: Date;
}
