import { useMemo } from 'react'
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
  type MutateOptions,
  type UseMutationResult,
} from '@tanstack/react-query'
import { captureRequestScope, requestScopeVersion } from './requestScope'
import { basisOf, displayedBasis, withEditBasis } from './editBasis'

// Stops delayed optimistic mutations and callbacks before they touch a replacement scope
export function useScopedMutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
  includeLibrary = true,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const client = useQueryClient()
  const assertScope = captureRequestScope(includeLibrary)
  type Invocation = { value: TVariables; basis: string | undefined }
  const callbacks = (source: MutateOptions<TData, TError, TVariables, TContext>) => ({
    onSuccess: (
      data: TData,
      input: Invocation,
      result: TContext | undefined,
      context: Parameters<NonNullable<typeof source.onSuccess>>[3],
    ) => {
      assertScope()
      return source.onSuccess?.(data, input.value, result, context)
    },
    onError: (
      error: TError,
      input: Invocation,
      result: TContext | undefined,
      context: Parameters<NonNullable<typeof source.onError>>[3],
    ) => {
      try {
        assertScope()
      } catch {
        return
      }
      return source.onError?.(error, input.value, result, context)
    },
    onSettled: (
      data: TData | undefined,
      error: TError | null,
      input: Invocation,
      result: TContext | undefined,
      context: Parameters<NonNullable<typeof source.onSettled>>[4],
    ) => {
      try {
        assertScope()
      } catch {
        return
      }
      return source.onSettled?.(data, error, input.value, result, context)
    },
  })
  const mutation = useMutation<TData, TError, Invocation, TContext>({
    ...options,
    onSuccess: (data, input, result, context) => {
      assertScope()
      return options.onSuccess?.(data, input.value, result, context)
    },
    onError: (error, input, result, context) => {
      try {
        assertScope()
      } catch {
        return
      }
      return options.onError?.(error, input.value, result, context)
    },
    onSettled: (data, error, input, result, context) => {
      try {
        assertScope()
      } catch {
        return
      }
      return options.onSettled?.(data, error, input.value, result, context)
    },
    mutationFn:
      options.mutationFn &&
      ((input, context) => {
        assertScope()
        return withEditBasis(input.basis, () => options.mutationFn!(input.value, context))
      }),
    onMutate:
      options.onMutate &&
      (async (input, context) => {
        assertScope()
        const result = await options.onMutate!(input.value, context)
        assertScope()
        return result
      }),
  })
  const invocation = (value: TVariables): Invocation => ({
    value,
    basis: basisOf(value) ?? displayedBasis(client),
  })
  return {
    ...mutation,
    variables: mutation.variables?.value,
    mutate: (value, callbackOptions) =>
      mutation.mutate(
        invocation(value as TVariables),
        callbackOptions && callbacks(callbackOptions),
      ),
    mutateAsync: (value, callbackOptions) =>
      mutation.mutateAsync(
        invocation(value as TVariables),
        callbackOptions && callbacks(callbackOptions),
      ),
  } as UseMutationResult<TData, TError, TVariables, TContext>
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
