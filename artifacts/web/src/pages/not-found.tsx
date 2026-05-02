import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4">
        <h1 className="text-5xl font-bold text-foreground">404</h1>
        <p className="text-muted-foreground">Page not found.</p>
        <Link href="/" className="text-sm text-primary hover:underline">
          Go home
        </Link>
      </div>
    </div>
  );
}
