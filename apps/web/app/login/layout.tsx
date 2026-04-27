export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm md:shadow-lg md:rounded-2xl md:border md:border-border md:bg-card md:p-8">
        {children}
      </div>
    </div>
  );
}
