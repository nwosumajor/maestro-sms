// Directory search (people) DTOs.

/** A person (student or staff) matched by the directory search. */
export interface PersonSearchResultDto {
  userId: string;
  uniqueId: string;
  name: string;
  email: string;
  roles: string[];
  status: string;
  schoolId: string;
  schoolName: string;
  /** City / state / country, when the person has a student profile. */
  location: string | null;
}
