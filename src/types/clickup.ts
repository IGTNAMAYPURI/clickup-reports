export interface ClickUpTask {
  id: string;
  name: string;
  description: string;
  status: { status: string; type: string };
  priority: { id: string; priority: string } | null;
  assignees: { id: number; username: string; email: string }[];
  tags: { name: string }[];
  due_date: string | null;
  date_created: string;
  date_closed: string | null;
  date_updated: string;
  custom_fields: ClickUpCustomField[];
  parent: string | null;
  url: string;
  list: { id: string; name: string };
  folder: { id: string; name: string };
  space: { id: string };
  time_estimate: number | null;
  points: number | null;
  subtasks?: ClickUpTask[];
}

export interface ClickUpCustomField {
  id: string;
  name: string;
  type: string;
  value: unknown;
}

export interface TimeInStatusResponse {
  current_status: { status: string; total_time: { by_minute: number } };
  status_history: { status: string; total_time: { by_minute: number } }[];
}

export interface ClickUpMember {
  user: {
    id: number;
    username: string;
    email: string;
    color: string;
    profilePicture: string | null;
    initials: string;
    role: number;
  };
}
