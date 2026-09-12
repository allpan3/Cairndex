import { useMemo } from 'react'
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query'
import { captureRequestScope, requestScopeVersion } from './requestScope'

// Stops delayed optimistic mutations and callbacks before they touch a replacement scope
export function useScopedMutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(options: UseMutationOptions<TData, TError, TVariables, TContext>, includeLibrary = true) {
  const assertScope = captureRequestScope(includeLibrary)
  return useMutation<TData, TError, TVariables, TContext>({
    ...options,
    mutationFn:
      options.mutationFn &&
      ((...args) => {
        assertScope()
        return options.mutationFn!(...args)
      }),
    onMutate:
      options.onMutate &&
      (async (...args) => {
        assertScope()
        const result = await options.onMutate!(...args)
        assertScope()
        return result
      }),
    onSuccess: (...args) => {
      assertScope()
      return options.onSuccess?.(...args)
    },
    onError: (...args) => {
      try {
        assertScope()
      } catch {
        return
      }
      return options.onError?.(...args)
    },
    onSettled: (...args) => {
      try {
        assertScope()
      } catch {
        return
      }
      return options.onSettled?.(...args)
    },
  })
}

// Prevents optimistic continuations from writing an old snapshot into the replacement library cache
export function useScopedQueryClient(includeLibrary = true): QueryClient {
  const client = useQueryClient()
  const version = requestScopeVersion(includeLibrary)
  return useMemo(() => {
    const assertScope = captureRequestScope(includeLibrary, version)
    return new Proxy(client, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          assertScope()
          return Reflect.apply(value, target, args)
        }
      },
    })
  }, [client, version, includeLibrary])
}
