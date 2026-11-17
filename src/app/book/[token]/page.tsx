import { BookingClient } from "../BookingClient";
export default async function Page({ params }: { params: Promise<{ token: string }> }) { return <BookingClient token={(await params).token} />; }
