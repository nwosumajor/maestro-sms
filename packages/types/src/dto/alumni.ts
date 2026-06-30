// Alumni Management response DTOs (server form; Date fields are Date).

export interface AlumnusDto {
  id: string;
  userId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  graduationYear: number | null;
  lastClass: string | null;
  occupation: string | null;
  notes: string | null;
  createdAt: Date;
}
