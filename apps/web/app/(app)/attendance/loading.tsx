import { PageSkeleton, SkeletonCard, SkeletonTable } from "@/components/shell/Skeleton";

/** Attendance is the heaviest page in the app — two boards, the register form and
 *  a history table — so it gets a skeleton shaped like that rather than the
 *  generic one, and the eye lands in the right place when the content swaps in. */
export default function Loading() {
  return (
    <PageSkeleton>
      <SkeletonCard rows={2} />
      <SkeletonCard rows={4} />
      <SkeletonCard rows={3} />
      <SkeletonTable rows={8} />
    </PageSkeleton>
  );
}
