/**
 * Health check endpoint for deployment platforms and container probes.
 */
export async function GET(): Promise<Response> {
  return Response.json(
    {
      status: 'ok',
      timestamp: new Date().toISOString(),
      // ASU: which build is actually serving this request.
      //
      // Read straight from the image's own SIM_VERSION (see docker/app.Dockerfile)
      // rather than from the chart or package.json — both of those can say one
      // thing while a different image is running. This is the answer to "are we
      // on the new version yet?", which otherwise requires kubectl.
      //
      // "unknown" means the image was built without --build-arg SIM_VERSION,
      // not that the deployment is broken.
      version: process.env.SIM_VERSION ?? 'unknown',
    },
    { status: 200 }
  )
}
