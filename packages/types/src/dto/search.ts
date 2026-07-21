/** One global-search hit, with a link into the app. */
export interface SearchHitDto {
  kind: "student" | "staff" | "class" | "invoice";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

export interface SearchResultDto {
  query: string;
  hits: SearchHitDto[];
}
